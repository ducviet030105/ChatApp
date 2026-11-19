import dotenv from "dotenv";
import { Server as SocketIOServer, type Socket } from "socket.io";
import jwt from "jsonwebtoken";
import { registerUserEvents } from "./UserEvent.js";
import { registerChatEvents } from "./chatEvent.js";
import Conversation from "../modals/Conversation.js";
import { registerFriendEvents } from "./friendEvent.js";
import { registerGroupEvents } from "./groupEvent.js";
dotenv.config();
export function initializeSocket(server: any): SocketIOServer {
  const io = new SocketIOServer(server, {
    cors: {
      origin: "*",
    },
  });
  io.use((socket: Socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error("Authentication error: no token provider"));
    }
    jwt.verify(
      token,
      process.env.JWT_SECRET as string,
      (err: any, decode: any) => {
        if (err) {
          return next(new Error("Authentication error: invalid token"));
        }
        let userData = decode.user;
        // socket.data = userData;
        // socket.data.userId = userData.id;
        socket.data = {
          ...userData,
          userId: userData.id,
        };
        next();
      },
    );
  });
  io.on("connection", async (socket: Socket) => {
    const userId = socket.data.userId;
    console.log(`User connected: ${userId}, username: ${socket.data.name}`);

    registerUserEvents(io, socket);
    registerChatEvents(io, socket);
    registerFriendEvents(io, socket);
    registerGroupEvents(io, socket);

    try {
      const conversations = await Conversation.find({
        participants: userId,
      }).select("_id");
      conversations.forEach((conversation) => {
        socket.join(conversation._id.toString());
      });
    } catch (error: any) {
      console.log("Error joining conversation", error);
    }

    socket.on("disconnect", () => {
      console.log(`User disconnect: ${userId}`);
    });
  });
  return io;
}
