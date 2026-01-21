let db, collection, addDoc;

import("./firebase.js")
  .then(module => {
    db = module.db;
    collection = module.collection;
    addDoc = module.addDoc;
    console.log("Firebase loaded");
  })
  .catch(err => {
    console.warn("Firebase not available, continuing without it", err);
  });

const academicFields = document.getElementById("academicFields");
const token = localStorage.getItem("token");

document.querySelectorAll('input[name="level"]').forEach(radio => {
  radio.addEventListener("change", () => {
    academicFields.innerHTML = "";
    const level = radio.value;

    if (level === "school") {
      academicFields.innerHTML = `
        <label>Class / Grade</label>
        <input type="text" id="classGrade" required />

        <label>Board</label>
        <input type="text" id="board" />

        <label>Stream</label>
        <input type="text" id="stream" />

        <label>School Name</label>
        <input type="text" id="institution" />
      `;
    }

    if (level === "ug" || level === "pg") {
      academicFields.innerHTML = `
        <label>Degree</label>
        <input type="text" id="degree" required />

        <label>Major / Discipline</label>
        <input type="text" id="major" />

        <label>Semester / Year</label>
        <input type="text" id="semester" />

        <label>University / College</label>
        <input type="text" id="institution" />
      `;
    }

    if (level === "phd") {
      academicFields.innerHTML = `
        <label>Field</label>
        <input type="text" id="field" required />

        <label>Research Area</label>
        <input type="text" id="research" />

        <label>University</label>
        <input type="text" id="institution" />
      `;
    }
  });
});

document.getElementById("profileForm").addEventListener("submit", async e => {
  e.preventDefault();

  const level = document.querySelector('input[name="level"]:checked')?.value;
  if (!level) return alert("Select academic level");

  const profile = {
    name: document.getElementById("name").value,
    email: document.getElementById("email").value,
    phone: document.getElementById("phone").value,
    level,
    academicData: {}
  };

  academicFields.querySelectorAll("input").forEach(input => {
    profile.academicData[input.id] = input.value;
  });
  
  if (db && addDoc && collection) {
  try {
    await addDoc(collection(db, "profiles"), {
      name: profile.name,
      email: profile.email,
      phone: profile.phone,
      level: profile.level,
      academicData: profile.academicData,
      createdAt: new Date()
    });

    console.log("Profile saved to Firebase");
  } catch (error) {
    console.error("Firebase error:", error);
  }
} else {
  console.warn("Firebase not connected — skipped cloud save");
}

  // Save locally (instant UX)
  localStorage.setItem("athenaProfile", JSON.stringify(profile));

  // Save to backend (persistent)
  if (token) {
    await fetch("http://localhost:3001/profile", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(profile)
    });
  }

  window.location.href = "index.html";
});
