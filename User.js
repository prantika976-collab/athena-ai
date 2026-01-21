import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  passwordHash: String,
  authProvider: { type: String, default: "email" },
  createdAt: { type: Date, default: Date.now },
  studyHistory: [],
  savedMaterials: [],
  preferences: {}
});

export default mongoose.model("User", userSchema);
