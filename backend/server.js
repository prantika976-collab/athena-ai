import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import mongoose from "mongoose";
import OpenAI from "openai";

dotenv.config();

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(cors());
app.use(express.json());

/* ================= DATABASE ================= */

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => {
    console.error("❌ MongoDB error:", err.message);
    process.exit(1);
  });

/* ================= SCHEMAS ================= */

const conversationSchema = new mongoose.Schema({
  title: { type: String, default: "Study Session" },
  createdAt: { type: Date, default: Date.now },

  longTermMemory: {
    summary: { type: String, default: "" },
    lastUpdatedAt: { type: Date }
  },

  /* -------- STUDY MODE STATE -------- */
  studyState: {
    phase: { type: String, default: "GREET" },

    subject: String,

    syllabusText: String,
    syllabusSource: String,

    // parsed structure
    parsedUnits: [
      {
        title: String,
        topics: [String]
      }
    ],
    currentUnitIndex: { type: Number, default: 0 },

    // teaching flow
    teachingStep: {
      type: String,
      default: "DETAIL" // DETAIL → ELI5 → SHORT → SUMMARY
    },

    // questions
    questionTypes: {
      type: [String],
      default: [
        "MCQs",
        "Fill in the blanks",
        "True or False",
        "Match the following",
        "Short answer",
        "Long answer",
        "Case study",
        "Numericals"
      ]
    },
    currentQuestionTypeIndex: { type: Number, default: 0 },
    questionBatch: { type: Number, default: 0 }
  },

    /* -------- COMPETITIVE PREP MODE STATE -------- */
  competitiveState: {
    active: { type: Boolean, default: false }
  },

  /* -------- EXAM MODE STATE -------- */
  examState: {
  active: { type: Boolean, default: false },

  /* conversational control */
  phase: { type: String, default: "FREE_CHAT" },

  /* confirmation flow */
  examType: String, // school | university
  classLevel: String, // class / semester
  degree: String,
  courseType: String, // Core, DSE, SEC, VAC, etc.
  subject: String,
  subjectCode: String,

  /* syllabus */
  syllabusText: String,
  syllabusSource: String, // PASTE | FETCH

  parsedStructure: [
    {
      unitTitle: String,
      topics: [String],
      completed: { type: Boolean, default: false }
    }
  ],

  currentUnitIndex: { type: Number, default: 0 },

  awaitingConfirmation: String, // "SHORT_NOTES" | "FLASHCARDS" | etc.

  lastActivityAt: { type: Date }
}
});

const messageSchema = new mongoose.Schema({
  conversationId: mongoose.Schema.Types.ObjectId,
  role: String,
  content: String,
  createdAt: { type: Date, default: Date.now }
});

const Conversation = mongoose.model("Conversation", conversationSchema);
const Message = mongoose.model("Message", messageSchema);

/* ================= MENTOR SCHEMAS ================= */

const mentorConversationSchema = new mongoose.Schema({
  createdAt: { type: Date, default: Date.now }
});

const mentorMessageSchema = new mongoose.Schema({
  conversationId: mongoose.Schema.Types.ObjectId,
  role: String, // "user" | "assistant"
  content: String,
  createdAt: { type: Date, default: Date.now }
});

const MentorConversation = mongoose.model(
  "MentorConversation",
  mentorConversationSchema
);

const MentorMessage = mongoose.model(
  "MentorMessage",
  mentorMessageSchema
);

/* ================= OPENAI ================= */

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/* ================= HELPERS ================= */

const isGreeting = t =>
  /^(hi|hello|hey|yo|hii|hiii)$/i.test(t.trim());

function extractSubject(text) {
  const patterns = [
    /study (.+)/i,
    /learn (.+)/i,
    /about (.+)/i,
    /(.+)/i
  ];

  for (const p of patterns) {
    const match = text.match(p);
    if (match) return match[1].trim();
  }
  return text.trim();
}

async function generateConversationTitle(summary) {
  const prompt = `
Create a short, clear academic chat title (max 8 words).

Rules:
- Be specific, not generic
- Reflect the main task or project
- No emojis
- No quotes
- No punctuation at the end

Examples:
DSA Stack Assignment
Physics Projectile Motion Homework
AI Essay Competition Prep
Web Development Mini Project

Conversation summary:
${summary}
`;

  const ai = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [{ role: "user", content: prompt }]
  });

  return ai.choices[0].message.content.trim();
}

async function updateLongTermMemory(convo) {
  const recentMessages = await Message.find({
    conversationId: convo._id
  })
    .sort({ createdAt: 1 })
    .limit(25); // enough to summarize meaningfully

  const prompt = `
Summarize the ongoing academic work.

Include:
- What the user is working on
- What has been completed
- What remains
- Any preferences or constraints

Do NOT include greetings.
Max 150 words.
`;

  const ai = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: prompt },
      ...recentMessages.map(m => ({
        role: m.role,
        content: m.content
      }))
    ]
  });

  const summary = ai.choices[0].message.content;

  convo.longTermMemory.summary = summary;
  convo.longTermMemory.lastUpdatedAt = new Date();

  // 🔥 AUTO-RENAME CHAT
  convo.title = await generateConversationTitle(summary);

  await convo.save();
}

/* ================= AI CHAT ================= */

app.post("/ai/chat", async (req, res) => {
  try {
    const { userMessage, conversationId, profile } = req.body;
    const msg = userMessage.trim();
    const upper = msg.toUpperCase();

    let convo = conversationId
      ? await Conversation.findById(conversationId)
      : null;

    if (!convo) convo = await Conversation.create({});
    const state = convo.studyState;

    /* ---------- GREET ---------- */
    if (state.phase === "GREET") {
      state.phase = "ASK_SUBJECT";
      await convo.save();

      return res.json({
        conversationId: convo._id,
        reply: "Hey 😊 What would you like to study today?"
      });
    }

    /* ---------- ASK SUBJECT ---------- */
    if (state.phase === "ASK_SUBJECT") {
      state.subject = extractSubject(msg);
      state.phase = "ASK_SYLLABUS_SOURCE";
      await convo.save();

      return res.json({
        conversationId: convo._id,
        reply: `Got it 👍 We’ll study **${state.subject}**.

Would you like to **UPLOAD a syllabus** or should I **FETCH SYLLABUS** automatically?`
      });
    }

    /* ---------- ASK SYLLABUS SOURCE ---------- */
    if (state.phase === "ASK_SYLLABUS_SOURCE") {
      if (upper.startsWith("UPLOAD")) {
        state.syllabusSource = "UPLOAD";
        state.syllabusText = "User provided syllabus";
        state.phase = "SYLLABUS_READY";
        await convo.save();

        return res.json({
          conversationId: convo._id,
          reply: "📄 Syllabus noted. Reply **LOCK SYLLABUS** when ready."
        });
      }

      if (upper.startsWith("FETCH")) {
        const { institution, level, board, degree, major } =
          profile?.academicData || {};

        const prompt = `
You are an academic curriculum expert.

Reconstruct the most appropriate syllabus using globally accepted standards.

Rules:
- School → follow board/curriculum
- University → follow common program structures
- No browsing mentions
- No questions back to user

Context:
Subject: ${state.subject}
Institution: ${institution || "Not specified"}
Level: ${level || "Not specified"}
Board/University: ${board || "Not specified"}
Degree: ${degree || "Not specified"}
Major: ${major || "Not specified"}
`;

        const ai = await openai.chat.completions.create({
          model: "gpt-4.1-mini",
          messages: [{ role: "user", content: prompt }]
        });

        state.syllabusText = ai.choices[0].message.content;
        state.syllabusSource = "FETCH";
        state.phase = "SYLLABUS_READY";
        await convo.save();

        return res.json({
          conversationId: convo._id,
          reply: `📘 **Syllabus fetched**:\n\n${state.syllabusText}\n\nReply **LOCK SYLLABUS** to continue.`
        });
      }
    }

   /* ---------- SYLLABUS READY ---------- */
if (state.phase === "SYLLABUS_READY") {
  if (upper === "LOCK" || upper === "LOCK SYLLABUS") {

    const unitPrompt = `
You are an academic planner.

Split the syllabus into sequential study units or weeks.
Return STRICT JSON ONLY. No explanations. No markdown.

Required format:
[
  {
    "title": "Unit / Week name",
    "topics": ["topic 1", "topic 2", "topic 3"]
  }
]

Syllabus:
${state.syllabusText}
`;

    const unitAI = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: unitPrompt }]
    });

    /* --------- 🛡️ SAFE JSON PARSING --------- */
    let raw = unitAI.choices[0].message.content;

    raw = raw
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();

    if (!raw.startsWith("[") || !raw.endsWith("]")) {
      throw new Error("Invalid JSON returned for syllabus units");
    }

    const parsedUnits = JSON.parse(raw);

    /* --------- STATE SETUP --------- */
    state.parsedUnits = parsedUnits;
    state.currentUnitIndex = 0;
    state.teachingStep = "DETAIL"; // DETAIL → ELI5 → SHORT → SUMMARY → QUESTIONS
    state.questionType = "MCQs";
    state.questionBatch = 0;
    state.phase = "TEACHING";

    await convo.save();

    return res.json({
      conversationId: convo._id,
      reply: `🔒 **Syllabus locked successfully**.

📘 Starting **${parsedUnits[0].title}**

I’ll begin with **detailed notes**, then:
• ELI5 explanation  
• Short notes  
• Key summary  
• Practice questions  

Reply **YES** to begin.`
    });
  }

  return res.json({
    conversationId: convo._id,
    reply: "Reply **LOCK SYLLABUS** when you’re ready 🙂"
  });
}


/* ---------- TEACHING ---------- */
if (state.phase === "TEACHING") {
  const unit = state.parsedUnits[state.currentUnitIndex];
  let instruction = "";

  if (state.teachingStep === "DETAIL")
    instruction = `
You are an expert teacher creating FULL, EXAM-READY STUDY NOTES.

Write VERY DETAILED notes.
Rules:
- Cover EVERY topic and sub-topic in depth
- Explain concepts, definitions, mechanisms, and reasoning
- Include examples wherever applicable
- Use clear headings, subheadings, bullet points
- This must look like a textbook chapter, NOT a summary
- Do NOT ask questions
`;

  if (state.teachingStep === "ELI5")
    instruction = `
Explain the SAME content again in ELI5 style.
Rules:
- Simple language
- Analogies and intuitive explanations
- Assume a beginner
- No technical overload
`;

  if (state.teachingStep === "SHORT")
    instruction = `
Create SHORT NOTES.
Rules:
- Concise
- Exam-oriented
- Bullet points only
- Definitions, formulas, keywords
`;

  if (state.teachingStep === "SUMMARY")
    instruction = `
Create a FINAL SUMMARY.
Rules:
- Key takeaways only
- Very crisp
- Revision-focused
`;

  const prompt = `
${instruction}

Subject: ${state.subject}
Unit: ${unit.title}
Topics to cover:
${unit.topics.join(", ")}

Do NOT include questions in this response.
`;

  const ai = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [{ role: "user", content: prompt }]
  });

  // advance teaching step
  if (state.teachingStep === "DETAIL") state.teachingStep = "ELI5";
  else if (state.teachingStep === "ELI5") state.teachingStep = "SHORT";
  else if (state.teachingStep === "SHORT") state.teachingStep = "SUMMARY";
  else {
    state.phase = "QUESTION_MODE";
    state.teachingStep = "DETAIL";
    await convo.save();

    return res.json({
      conversationId: convo._id,
      reply: `${ai.choices[0].message.content}

Ready for **practice questions**? Reply **YES**.`
    });
  }

  await convo.save();
  return res.json({
    conversationId: convo._id,
    reply: `${ai.choices[0].message.content}

Reply **YES** to continue.`
  });
}


/* ---------- QUESTION MODE ---------- */
if (state.phase === "QUESTION_MODE") {
  const qType = state.questionTypes[state.currentQuestionTypeIndex];
  const unit = state.parsedUnits[state.currentUnitIndex];

  if (upper === "NO") {
    state.currentQuestionTypeIndex += 1;
    state.questionBatch = 0;

    if (state.currentQuestionTypeIndex >= state.questionTypes.length) {
      state.currentUnitIndex += 1;
      state.currentQuestionTypeIndex = 0;
      state.phase = "TEACHING";
      await convo.save();

      return res.json({
        conversationId: convo._id,
        reply: `📘 Moving to **${state.parsedUnits[state.currentUnitIndex]?.title}**.
Reply **YES** to continue.`
      });
    }

    await convo.save();
    return res.json({
      conversationId: convo._id,
      reply: `Next: **${state.questionTypes[state.currentQuestionTypeIndex]}**.
Reply **YES** to begin.`
    });
  }

  state.questionBatch += 1;
  await convo.save();

  const qPrompt = `
You are an exam question setter.

Generate 10 ${qType} questions.

Context:
Subject: ${state.subject}
Unit: ${unit.title}
Topics:
${unit.topics.join(", ")}

MANDATORY RULES:
- ALL questions MUST include correct answers
- Clearly label QUESTION and ANSWER
- Mix difficulty levels (easy, medium, hard)
- Exam-oriented language

SUBJECT-SPECIFIC RULES:
- If subject involves programming:
  • Include code-based questions
  • Include "predict the output" questions
- If subject involves mathematics:
  • Include numericals with step-by-step solutions
- If subject involves science:
  • Include application or diagram-based questions
- If subject involves theory/arts:
  • Include analytical and descriptive questions

Do NOT ask the user anything.
`;

  const ai = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [{ role: "user", content: qPrompt }]
  });

  return res.json({
    conversationId: convo._id,
    reply: `${ai.choices[0].message.content}

Generate **10 more ${qType}**? Reply **YES** or **NO**.`
  });
}
  } catch (err) {
    console.error("❌ AI ERROR:", err);
    res.status(500).json({ error: "AI failed" });
  }
});

/* ================= MENTOR MODE (WITH MEMORY) ================= */

app.post("/ai/mentor", async (req, res) => {
  try {
    const { userMessage, mentorConversationId } = req.body;

    let convo = mentorConversationId
      ? await MentorConversation.findById(mentorConversationId)
      : null;

    if (!convo) convo = await MentorConversation.create({});

    // Save user message
    await MentorMessage.create({
      conversationId: convo._id,
      role: "user",
      content: userMessage
    });

    // Load last 10 messages for context
    const history = await MentorMessage.find({
      conversationId: convo._id
    })
      .sort({ createdAt: 1 })
      .limit(10);

    const systemPrompt = `
You are a supportive academic mentor and coach.

Your role:
- Academic planning
- Productivity and focus
- Motivation and burnout handling
- Learning strategies
- Skill-building related to academics
- Light academic career guidance only

Rules:
- Free-flow conversation
- No rigid structure
- No "Reply YES" style instructions
- Be empathetic, practical, and motivating
- Not clinical, not strict
- Speak like a senior mentor

Tone:
Friendly, calm, confident, reassuring
`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...history.map(m => ({
        role: m.role,
        content: m.content
      }))
    ];

    const ai = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages
    });

    const reply = ai.choices[0].message.content;

    // Save AI reply
    await MentorMessage.create({
      conversationId: convo._id,
      role: "assistant",
      content: reply
    });

    return res.json({
      mentorConversationId: convo._id,
      reply
    });

  } catch (err) {
    console.error("❌ MENTOR MODE ERROR:", err);
    res.status(500).json({ error: "Mentor mode failed" });
  }
});

/* ================= COMPETITIVE PREP MODE ================= */

app.post("/ai/competition", async (req, res) => {
  try {
    const { userMessage, conversationId, profile } = req.body;

    let convo = conversationId
      ? await Conversation.findById(conversationId)
      : null;

    if (!convo) {
      convo = await Conversation.create({
        title: "Competitive Prep Session",
        competitiveState: { active: true }
      });
    }

    // Save user message
    await Message.create({
      conversationId: convo._id,
      role: "user",
      content: userMessage
    });

    // Fetch recent messages for memory (last 10 is enough)
    const history = await Message.find({ conversationId: convo._id })
      .sort({ createdAt: 1 })
      .limit(10);

    const systemPrompt = `
You are an Academic Competition Coach and Judge Simulator.

Your job is to help students prepare for academic and co-curricular competitions,
AND simulate how judges would evaluate them when requested.

━━━━━━━━━━━━━━━━━━━━━━
AUTO-DETECTION LOGIC (MANDATORY)
━━━━━━━━━━━━━━━━━━━━━━
From each user message, IMPLICITLY identify:
1) Competition type (e.g., debate, quiz, essay, poetry, story, speech, Olympiad, MUN, presentation, etc.)
2) User intent:
   - preparation / coaching
   - content generation
   - improvement / refinement
   - judge-style feedback
   - evaluation / scoring

DO NOT ask the user what competition it is unless absolutely unclear.

If the user switches competition type in the same chat,
you MUST adapt immediately and discard the previous competition frame.

━━━━━━━━━━━━━━━━━━━━━━
SUPPORTED COMPETITIONS (GLOBAL, NOT EXHAUSTIVE)
━━━━━━━━━━━━━━━━━━━━━━
• Debate, elocution, speech, extempore, group discussion, MUN  
• Quiz competitions, academic Olympiads (conceptual, not exam prep)  
• Essay writing, story writing, poetry, article writing  
• Creative writing, abstract writing, reflective writing  
• Presentations, poster competitions, research showcases  
• Drama, skits, mono-acting (guidance only)  
• Singing, dancing, anchoring (text-based coaching only)

━━━━━━━━━━━━━━━━━━━━━━
JUDGE SIMULATION MODE
━━━━━━━━━━━━━━━━━━━━━━
If the user asks things like:
- “Judge this”
- “Give feedback”
- “Evaluate this”
- “How would judges see this?”
- “Score this”

Then respond AS A JUDGE using:
• Strengths
• Weaknesses
• Clarity & structure
• Creativity / originality
• Delivery / expression (if applicable)
• A short improvement plan
• Optional indicative score (out of 10 or 100)

Make it realistic, fair, and encouraging — not harsh.

━━━━━━━━━━━━━━━━━━━━━━
CONTENT GENERATION RULES
━━━━━━━━━━━━━━━━━━━━━━
• Do NOT generate long content unless:
  - user explicitly asks, OR
  - user agrees after you suggest it
• If generating content, match the EXACT competition format
• Do NOT reuse themes, tone, or structure from earlier responses unless the user asks

━━━━━━━━━━━━━━━━━━━━━━
TONE & STYLE
━━━━━━━━━━━━━━━━━━━━━━
• Friendly, intelligent, mentor-like
• Creative but structured
• Encouraging, never discouraging
• Not strict, not slangy

━━━━━━━━━━━━━━━━━━━━━━
RESTRICTIONS
━━━━━━━━━━━━━━━━━━━━━━
• NO competitive entrance exams
• NO sports coaching
• Academics and academic competitions ONLY

━━━━━━━━━━━━━━━━━━━━━━
ROLE OVERRIDE RULE (CRITICAL)
━━━━━━━━━━━━━━━━━━━━━━
If the user asks for evaluation, judging, feedback, scoring, or review:

- IMMEDIATELY switch into JUDGE ROLE
- IGNORE previous creative, coaching, or ideation context
- DO NOT greet the user
- DO NOT ask what they want
- DO NOT continue creative suggestions
- Respond ONLY as a competition evaluator

Judge responses MUST start directly with evaluation
(e.g., "Strengths:", "Evaluation:", "Feedback:", etc.)

After judging is complete, you may ask ONE optional follow-up question
only if it helps improvement.
`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...history.map(m => ({
        role: m.role,
        content: m.content
      }))
    ];

    const ai = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages
    });

    const reply = ai.choices[0].message.content;

    // Save AI reply
    await Message.create({
      conversationId: convo._id,
      role: "assistant",
      content: reply
    });

    return res.json({
      conversationId: convo._id,
      reply
    });

  } catch (err) {
    console.error("❌ COMPETITIVE MODE ERROR:", err);
    res.status(500).json({ error: "Competitive mode failed" });
  }
});

app.post("/ai/exam", upload.single("file"), async (req, res) => {
  try {
    const { userMessage = "", conversationId, profile } = req.body;

    let convo = conversationId
      ? await Conversation.findById(conversationId)
      : null;

    if (!convo) {
      convo = await Conversation.create({
        title: "Exam Preparation",
        examState: { active: true, phase: "FREE_CHAT" }
      });
    }

    const state = convo.examState;
    state.lastActivityAt = new Date();

    // Save user message
    if (userMessage.trim()) {
      await Message.create({
        conversationId: convo._id,
        role: "user",
        content: userMessage
      });
    }

    /* ===================== FILE UPLOAD ===================== */
if (req.file) {
  state.syllabusSource = "UPLOAD";
  state.phase = "SYLLABUS_PRESENT";

  await convo.save();

  return res.json({
    conversationId: convo._id,
    reply: `📄 **File uploaded successfully.**

I’ve stored the syllabus file.

For now, please:
• paste the syllabus text here, OR  
• ask me to **fetch the syllabus**, OR  
• tell me what topics you want to study

(Automatic file reading will be added later.)`
  });
}

    /* ===================== FETCH SYLLABUS ===================== */
    const wantsFetch =
  /fetch|get|generate|you do|don'?t have|create|make syllabus/i.test(userMessage);

  if (wantsFetch && state.subject) {
      const { institution, level, board, degree, major } =
        profile?.academicData || {};

    const prompt = `
You are an academic curriculum expert.

Reconstruct an academically accurate, exam-oriented syllabus.

STRICT RULES:
- Subject is PRIMARY, degree is CONTEXT only
- Do NOT assume degree name is subject
- Follow Indian university norms if applicable
- No explanations, no questions
- Output MUST be detailed and usable for exam preparation

SYLLABUS STRUCTURE RULES:
- Return UNIT-WISE syllabus
- Each unit must include:
  • Unit title
  • Major topics
  • Important subtopics / keywords
- Depth should match Indian university semester exams
- Do NOT summarise vaguely

Subject: ${state.subject}
Degree: ${degree || "Not specified"}
Major: ${major || "Not specified"}
Board/University: ${board || "Not specified"}
Level: ${level || "Not specified"}

Return the FULL DETAILED SYLLABUS CONTENT ONLY.
`;

      const ai = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [{ role: "user", content: prompt }]
      });

      state.syllabusText = ai.choices[0].message.content;
      state.syllabusSource = "FETCH";
      state.phase = "SYLLABUS_PRESENT";

      await convo.save();

      return res.json({
        conversationId: convo._id,
        reply: `📘 **Fetched syllabus:**\n\n${state.syllabusText}\n\nTell me how you want to study this.`
      });
    }

    /* ===================== NORMAL CHAT / STUDY ===================== */
    const systemPrompt = `
You are Athena – an intelligent Exam Preparation Companion.

━━━━━━━━━━━━━━━━━━━━━━
CORE BEHAVIOR
━━━━━━━━━━━━━━━━━━━━━━
• Start with NORMAL conversation (hi, hello, casual chat)
• The user can type ABSOLUTELY ANYTHING
• Do NOT force structure unless the user signals exam intent
• If conversation is casual → respond casually
• If exam prep intent appears → switch to guided mode

━━━━━━━━━━━━━━━━━━━━━━
EXAM SETUP FLOW (SEQUENTIAL, NEVER ALL AT ONCE)
━━━━━━━━━━━━━━━━━━━━━━
When exam preparation begins, COLLECT information STEP BY STEP:

1️⃣ Ask whether this is:
   • School exam
   • University / College exam

2️⃣ Based on answer:
   • School → ask class & board
              → ALSO ask SCHOOL NAME
   • College → ask semester & degree
              → ALSO ask COLLEGE NAME
              → ALSO ask AFFILIATED UNIVERSITY

(These are required for syllabus accuracy but should be asked
politely and conversationally, not as a form.)

3️⃣ ONLY IF COLLEGE:
Ask subject COURSE TYPE:
• Core / Major
• DSE (Discipline Specific Elective)
• Minor
• SEC
• VAC
• VEC
• GE
• MDC
• Open / Optional

⚠️ VERY IMPORTANT RULE:
Unless course type is DSE or Core,
DO NOT assume the subject is related to the degree.

4️⃣ Ask for subject name (subject code optional)

━━━━━━━━━━━━━━━━━━━━━━
SYLLABUS HANDLING (CRITICAL)
━━━━━━━━━━━━━━━━━━━━━━
After subject confirmation:

1. Ask time availability BEFORE syllabus generation:
• How much time does the user have to prepare?
  - Few days
  - 1–2 weeks
  - 1 month
  - More than 1 month

Store this internally as preparation_time.

RULE:
• The depth and length of short notes MUST adapt to preparation_time
• Less time → highly condensed but exam-complete notes
• More time → fuller explanations, examples, and coverage

2. Ask how user wants syllabus:
  - Paste text
  - Fetch automatically

If fetching syllabus:
• Fetch based on SUBJECT FIRST
• Degree is CONTEXT only
• Do NOT merge disciplines unless explicitly DSE/Core
• AFTER fetching → ALWAYS DISPLAY the FULL DETAILED SYLLABUS
• NEVER say “fetching syllabus” without showing it

━━━━━━━━━━━━━━━━━━━━━━
INTERNAL STATE MANAGEMENT (IMPORTANT)
━━━━━━━━━━━━━━━━━━━━━━
Internally track:
• Current unit / chapter
• Current content format (notes, flashcards, MCQs, PYQs, mock test, etc.)

Default rules:
• Do NOT reset to Unit 1 unless user explicitly asks
• Do NOT change format unless user intent changes

━━━━━━━━━━━━━━━━━━━━━━
INTENT DETECTION & OVERRIDE RULES
━━━━━━━━━━━━━━━━━━━━━━
User intent ALWAYS overrides previous state.

Examples:
• “flashcards next” → switch FORMAT, keep current unit
• “biochemistry now” → switch UNIT, keep current format
• “flashcards for biochemistry” → switch BOTH
• “mock test for unit 3” → switch FORMAT + UNIT
• “pyqs from unit 4” → switch FORMAT + UNIT
• “continue” / “go on” → continue current unit + format

User can jump FREELY between:
• Units
• Topics
• Formats
• Order of study
• Previously covered or upcoming syllabus parts

━━━━━━━━━━━━━━━━━━━━━━
FREE NAVIGATION & NON-LINEAR STUDY (NEW)
━━━━━━━━━━━━━━━━━━━━━━
Athena MUST support NON-LINEAR study.

The user may at ANY TIME:
• Move from Topic 1 notes → Topic 5 quizzes
• Move from Topic 5 quizzes → Topic 3 flashcards
• Move from Topic 3 flashcards → Topic 4 PYQs
• Skip topics, revisit topics, or mix formats

There is NO fixed order.
The user's request ALWAYS defines:
• What to generate
• For which topic
• In which format

━━━━━━━━━━━━━━━━━━━━━━
STUDY FLOW (ASK BEFORE FIRST CONTENT ONLY)
━━━━━━━━━━━━━━━━━━━━━━
After syllabus is shown:
Ask ONCE how the user wants to study:
• Short notes
• Flashcards
• PYQs
• MCQs
• Detailed explanation
• Mock test

After that:
• Do NOT ask again unless user intent changes
• Detect intent implicitly (ok, next, flashcards pls, quizzes now, etc.)

━━━━━━━━━━━━━━━━━━━━━━
PER-UNIT GENERATION LOOP (NEW – IMPORTANT)
━━━━━━━━━━━━━━━━━━━━━━
After generating content for ANY unit/topic:

Athena MUST ask (conversationally):
• Want more of this format?
• Switch to a different format?
• Move to another topic/unit?

Examples:
• “Want flashcards for this unit?”
• “Do you want PYQs from this topic?”
• “Shall we move to another chapter?”

This loop repeats AFTER EVERY generation.

Athena MUST NOT:
• Force moving to next unit
• Force finishing one format before another
• Delay quizzes or PYQs to the end of syllabus

━━━━━━━━━━━━━━━━━━━━━━
PYQs & MOCK TEST PRIORITY RULES
━━━━━━━━━━━━━━━━━━━━━━
When generating PYQs or mock tests:
• ALWAYS prioritize:
  1. Most frequently asked questions
  2. Conceptually high-weightage topics
  3. Questions known to repeat or vary slightly

Order matters:
• High-importance questions FIRST
• Lower-importance questions later

QUESTION SET RULES:
• Minimum 50 questions per PYQ set or mock test
• Mix question types depending on subject:
  - MCQs / objectives
  - Short answer
  - Long answer
  - Numericals / problem-solving
  - Coding / logic-based (if applicable)

ANSWER KEY RULE:
• Initially provide QUESTIONS ONLY
• Do NOT include answers automatically
• Provide answers ONLY if user explicitly asks

POST-GENERATION FLOW:
After PYQs or mock tests:
• Ask if user wants:
  - More questions
  - Answer key
  - Switch topic
  - Switch format

━━━━━━━━━━━━━━━━━━━━━━
CONTENT QUALITY RULES
━━━━━━━━━━━━━━━━━━━━━━
SHORT NOTES MUST:
• Be concise but COMPLETE
• Include definitions, key terms, mechanisms, examples
• Be exam-ready
• Length proportional to preparation_time
• Never drop core concepts

FLASHCARDS MUST:
• Be Q–A or Term–Definition style
• Match syllabus depth
• Cover same concepts as notes, atomized

━━━━━━━━━━━━━━━━━━━━━━
TONE & STYLE
━━━━━━━━━━━━━━━━━━━━━━
• Human, calm, friendly
• Adaptive to user's mood
• Never robotic
• Never authoritative-examiner tone

━━━━━━━━━━━━━━━━━━━━━━
ABSOLUTE RESTRICTIONS
━━━━━━━━━━━━━━━━━━━━━━
• Do NOT assume subject
• Do NOT assume syllabus relevance to degree
• Do NOT dump content without permission
• Do NOT ignore explicit user intent
• Never interrupt the user's flow with rigid academic framing
`;

    const history = await Message.find({ conversationId: convo._id })
      .sort({ createdAt: 1 })
      .limit(20);

    const messages = [
      { role: "system", content: systemPrompt },
      ...history.map(m => ({
        role: m.role,
        content: m.content
      }))
    ];

    const ai = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages
    });

    const reply = ai.choices[0].message.content;

    await Message.create({
      conversationId: convo._id,
      role: "assistant",
      content: reply
    });

    return res.json({
      conversationId: convo._id,
      reply
    });

  } catch (err) {
    console.error("❌ EXAM MODE ERROR:", err);
    res.status(500).json({ error: "Exam mode failed" });
  }
});

/* ================= ASSIGNMENT / PROJECT MODE ================= */

app.post("/ai/assignment", async (req, res) => {
  try {
    const { userMessage, conversationId, profile } = req.body;

    let convo = conversationId
      ? await Conversation.findById(conversationId)
      : null;

    if (!convo) {
      convo = await Conversation.create({
        title: "Assignment / Project Session"
      });
    }

    // Save user message
    await Message.create({
      conversationId: convo._id,
      role: "user",
      content: userMessage
    });

    const recentHistory = await Message.find({
  conversationId: convo._id
})
  .sort({ createdAt: 1 })
  .limit(50);

const memorySummary = convo.longTermMemory?.summary || "";

    const systemPrompt = `
You are an Academic Assignment and Project Assistant.

Your role is to help students with ANY kind of academic work.
This includes, but is NOT limited to:
- Homework
- Assignments
- Projects
- Reports
- Essays
- Problem-solving
- Coding tasks
- Research work
- Lab work
- Case studies
- Presentations
- Drafting, editing, reviewing, or improving academic content

This list is NOT exhaustive.

━━━━━━━━━━━━━━━━━━━━━━
CORE BEHAVIOR (MANDATORY)
━━━━━━━━━━━━━━━━━━━━━━
From each user message, IMPLICITLY determine:
1) What academic task is being discussed
2) What kind of help the user wants:
   - full solution
   - step-by-step explanation
   - hints only
   - review / feedback
   - improvement / rewriting
   - idea generation
   - clarification of concepts

Do NOT assume the user wants a full solution.
If unclear, ask ONLY ONE short clarification question.

━━━━━━━━━━━━━━━━━━━━━━
CONTENT HANDLING RULES
━━━━━━━━━━━━━━━━━━━━━━
• If the user pastes:
  - a question → solve or explain it
  - a draft → review, improve, or critique
  - instructions → break them down and help execute
• Adapt your response format to the task:
  - Math → steps + final answer
  - Theory → structured explanation
  - Writing → clear, well-written text
  - Projects → logical planning and guidance

━━━━━━━━━━━━━━━━━━━━━━
STYLE & TONE
━━━━━━━━━━━━━━━━━━━━━━
• Natural, ChatGPT-like conversation
• Helpful, calm, and professional
• Not robotic
• Not overly verbose unless required
• No rigid templates unless useful

━━━━━━━━━━━━━━━━━━━━━━
ACADEMIC INTEGRITY (SUBTLE)
━━━━━━━━━━━━━━━━━━━━━━
If the task appears to be graded work:
• You MAY help fully if the user asks
• You MAY also suggest learning-focused alternatives
• Do NOT lecture or moralize
• Do NOT refuse by default

━━━━━━━━━━━━━━━━━━━━━━
MEMORY & CONTEXT
━━━━━━━━━━━━━━━━━━━━━━
• Use recent messages for context
• Adapt if the user switches task type mid-chat
• Do NOT get stuck in previous task framing

━━━━━━━━━━━━━━━━━━━━━━
RESTRICTIONS
━━━━━━━━━━━━━━━━━━━━━━
• Academics only
• No medical or legal advice
• No personal data handling
`;

    const messages = [
  {
    role: "system",
    content: `${systemPrompt}

LONG-TERM CONTEXT:
${memorySummary || "No prior context yet."}
`
  },
  ...recentHistory.map(m => ({
    role: m.role,
    content: m.content
  }))
];

    const ai = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages
    });

    const reply = ai.choices[0].message.content;

    // Save AI reply
    await Message.create({
      conversationId: convo._id,
      role: "assistant",
      content: reply
    });

    const messageCount = await Message.countDocuments({
  conversationId: convo._id
});

if (messageCount % 15 === 0) {
  await updateLongTermMemory(convo);
}

    return res.json({
      conversationId: convo._id,
      reply
    });

  } catch (err) {
    console.error("❌ ASSIGNMENT MODE ERROR:", err);
    res.status(500).json({ error: "Assignment mode failed" });
  }
});

/* ================= START ================= */

app.listen(3001, () => {
  console.log("🚀 Athena backend running on http://localhost:3001");
});
