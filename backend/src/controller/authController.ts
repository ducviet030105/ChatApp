import type { Request, Response } from "express";
import { createClerkClient, verifyToken } from "@clerk/backend";
import jwt from "jsonwebtoken";
import User from "../modals/User.js";
import bcrypt from "bcryptjs";
import { generateToken } from "../utils/token.js";

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });

export const registerUser = async (
  req: Request,
  res: Response,
) => {
  const { name, email, password, avatar } = req.body;

  try {
    if (!name || !email || !password) {
      res.status(400).json({
        success: false,
        message: "Please provide name, email and password",
      });
      return;
    }

    const existingUser = await User.findOne({ email });

    if (existingUser) {
      res.status(409).json({
        success: false,
        message: "User already exists",
      });
      return;
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const user = new User({
      name,
      email,
      password: hashedPassword,
      avatar: avatar || "",
    });

    await user.save();
    const token = generateToken(user);

    res.status(201).json({
      success: true,
      message: "Register successfully",
      token,
    });
  } catch (error) {
    console.log("Register error:", error);

    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

export const loginUser = async (req: Request, res: Response) => {
  const { email, password } = req.body;

  try {
    if (!email || !password) {
      return  res.status(400).json({
        success: false,
        message: "Vui lòng nhập email và mật khẩu",
      });
    }
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(400).json({
        success: false,
        message: "Sai email hoặc mật khẩu",
      });
    }
    if (!user.password) {
      return res.status(400).json({
        success: false,
        message: "Tài khoản này đăng nhập bằng Google",
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(400).json({
        success: false,
        message: "Sai email hoặc mật khẩu",
      });
    }
    const token = generateToken(user);
    res.status(200).json({
      success: true,
      token,
    });
  } catch (error) {
    console.log("Login error:", error);

    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};
export const clerkLogin = async (req: Request, res: Response) => {
  try {
    const clerkToken =
      req.headers.authorization?.replace("Bearer ", "") || req.body?.token;
    if (!clerkToken) {
      return res.status(401).json({ success: false, message: "Thiếu token" });
    }
    const payload = await verifyToken(clerkToken, {
      secretKey: process.env.CLERK_SECRET_KEY!,
    });
    const clerkId = payload.sub;

    const cu = await clerk.users.getUser(clerkId);
    const primary = cu.emailAddresses.find(
      (e) => e.id === cu.primaryEmailAddressId,
    );
    const email = primary?.emailAddress?.toLowerCase();
    if (!email) {
      return res
        .status(400)
        .json({ success: false, message: "Tài khoản không có email" });
    }
    const name =
      [cu.firstName, cu.lastName].filter(Boolean).join(" ") ||
      email.split("@")[0];
    let user = await User.findOne({ clerkId });
    if (!user) {
      const existing = await User.findOne({ email });
      if (existing) {
        if (primary?.verification?.status !== "verified") {
          return res
            .status(403)
            .json({ success: false, message: "Email chưa được xác minh" });
        }
        existing.clerkId = clerkId;
        if (!existing.avatar) existing.avatar = cu.imageUrl;
        await existing.save();
        user = existing;
      } else {
        user = await User.create({ clerkId, email, name, avatar: cu.imageUrl });
      }
    }
    const token = jwt.sign(
      {
        user: {
          id: user._id.toString(),
          email: user.email,
          name: user.name,
          avatar: user.avatar,
        },
      },
      process.env.JWT_SECRET as string,
      { expiresIn: "30d" },
    );
    return res.json({ success: true, token });
  } catch (error) {
    console.log("clerkLogin error:", error);
    return res
      .status(401)
      .json({ success: false, message: "Token Clerk không hợp lệ" });
  }
};

