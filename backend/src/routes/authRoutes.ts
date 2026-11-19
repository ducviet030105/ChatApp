import { Router } from "express";
import { clerkLogin, loginUser, registerUser } from "../controller/authController.js";

const router = Router();

router.post("/register", registerUser);
router.post("/login", loginUser);
router.post("/clerk", clerkLogin);


export default router;
