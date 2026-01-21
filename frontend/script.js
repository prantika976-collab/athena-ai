const userProfile = JSON.parse(localStorage.getItem("athenaProfile"));

if (!userProfile) {
  window.location.href = "profile.html";
}

/**************** CONFIG ****************/
let currentMode = "study";
let currentStudyMaterial = "";
let currentConversationId = null;       // study mode memory
let currentMentorConversationId = null; // mentor mode memory
let currentExamConversationId = null;   // exam mode memory

/**************** MODE SWITCH ****************/
document.querySelectorAll(".mode-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".mode-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentMode = btn.dataset?.mode || "study";
    chat.innerHTML = ""; // 🧹 clean slate when switching modes

if (currentMode === "study" || currentMode === "competition") {
  currentConversationId = null;
}

if (currentMode === "mentor") {
  currentMentorConversationId = null;
}

if (currentMode === "exam") {
  currentExamConversationId = null;
}});
});

/**************** BASIC REFERENCES ****************/
const chat = document.getElementById("chat-container");
const chatList = document.getElementById("chatList");
const token = localStorage.getItem("token");

/**************** AUTH HEADER ****************/
function authHeader() {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**************** CHAT UI HELPERS ****************/
function addUserMessage(text) {
  const div = document.createElement("div");
  div.className = "message user";
  div.textContent = text;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

function addAIMessage(markdownText) {
  const div = document.createElement("div");
  div.className = "message ai";

  const content = document.createElement("div");
  content.className = "ai-content";
  content.innerHTML = marked.parse(markdownText);

  const actions = document.createElement("div");
  actions.className = "ai-actions";

  const copyBtn = document.createElement("button");
  copyBtn.textContent = "📋 Copy";
  copyBtn.onclick = () => navigator.clipboard.writeText(markdownText);

  const pdfBtn = document.createElement("button");
  pdfBtn.textContent = "📄 Download PDF";
  pdfBtn.onclick = () => downloadPDF(markdownText);

  actions.append(copyBtn, pdfBtn);
  div.append(content, actions);

  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

function downloadPDF(text) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const lines = doc.splitTextToSize(text, 180);
  doc.text(lines, 10, 10);
  doc.save("athena-notes.pdf");
}

/**************** CHAT HISTORY ****************/
async function loadChats() {
  if (!token) return;

  const res = await fetch("http://localhost:3001/conversations", {
    headers: authHeader()
  });

  const chats = await res.json();
  chatList.innerHTML = "";

  chats.forEach(c => {
    const div = document.createElement("div");
    div.textContent = c.title || "Untitled Chat";
    div.onclick = () => loadConversation(c._id);
    chatList.appendChild(div);
  });
}

async function createNewChat() {
  currentConversationId = null;
  currentMentorConversationId = null;
  currentStudyMaterial = "";
  chat.innerHTML = "";
}

/**************** LOAD OLD CHAT ****************/
async function loadConversation(id) {
  currentConversationId = id;
  chat.innerHTML = "";

  const res = await fetch(
    `http://localhost:3001/conversations/${id}/messages`,
    { headers: authHeader() }
  );

  const messages = await res.json();
  messages.forEach(m => {
    m.role === "user"
      ? addUserMessage(m.content)
      : addAIMessage(m.content);
  });
}

document.getElementById("newChatBtn")
  ?.addEventListener("click", createNewChat);

/**************** FILE UPLOAD ****************/
document.getElementById("fileInput")
  ?.addEventListener("change", async (e) => {
        if (currentMode !== "exam") {
      addAIMessage("📁 File uploads are currently supported only in Exam Mode.");
      e.target.value = "";
      return;
      }
    
          const file = e.target.files[0];
    if (!file) return;

    addUserMessage(`Uploaded file: ${file.name}`);

    const formData = new FormData();
    formData.append("file", file);
    if (currentExamConversationId) {
      formData.append("conversationId", currentExamConversationId);
    }

    addAIMessage("📘 Processing syllabus…");

    const res = await fetch("http://localhost:3001/ai/exam", {
      method: "POST",
      headers: authHeader(),
      body: formData
    });

    const data = await res.json();

    if (data.conversationId && !currentExamConversationId) {
      currentExamConversationId = data.conversationId;
    }

    addAIMessage(data.reply);
    e.target.value = "";
    return;
 });

/**************** SEND MESSAGE ****************/

document.getElementById("sendBtn")
  ?.addEventListener("click", async () => {

    const input = document.getElementById("userInput");
    const text = input.value.trim();
    if (!text) return;

    addUserMessage(text);
    input.value = "";

    try {
      let endpoint = "http://localhost:3001/ai/chat";
      let payload = {
        userMessage: text,
        profile: userProfile,
        conversationId: currentConversationId
      };

      if (currentMode === "mentor") {
        endpoint = "http://localhost:3001/ai/mentor";
        payload = {
          userMessage: text,
          mentorConversationId: currentMentorConversationId
        };
      }

      if (currentMode === "competition") {
        endpoint = "http://localhost:3001/ai/competition";
        payload = {
          userMessage: text,
          profile: userProfile,
          conversationId: currentConversationId
        };
      }
        
      if (currentMode === "exam") {
        endpoint = "http://localhost:3001/ai/exam";
        payload = {
          userMessage: text,
          profile: userProfile,
          conversationId: currentExamConversationId
        };
      }

      if (currentMode === "assignment") {
        endpoint = "http://localhost:3001/ai/assignment";
        payload = {
          userMessage: text,
          profile: userProfile,
          conversationId: currentConversationId
        };
      }

      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeader()
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json();

      // Reset memory correctly per mode
      if (currentMode === "mentor") {
        currentMentorConversationId = null;
      }

      // Study, competition, assignment share persistent conversation memory
      if (
        (currentMode === "study" ||
        currentMode === "competition" ||
        currentMode === "assignment")
      && data.conversationId
      && !currentConversationId
      ) {
      currentConversationId = data.conversationId;
      }
      
      if (currentMode === "exam"
        && data.conversationId
      && !currentExamConversationId) {
      currentExamConversationId = data.conversationId;
    }

      addAIMessage(data.reply);

    } catch (err) {
      console.error(err);
      addAIMessage("❌ Error connecting to AI.");
    }
  });

/**************** RESET ON PAGE LOAD ****************/
window.addEventListener("load", () => {
  currentConversationId = null;
  currentMentorConversationId = null;
  currentExamConversationId = null;
  chat.innerHTML = "";
});

