import type { Socket, Server as SocketIOServer } from "socket.io";
import User from "../modals/User.js";
import { generateToken } from "../utils/token.js";

export function registerUserEvents(io: SocketIOServer, socket: Socket) {
  socket.on("testSocket", (data) => {
    socket.emit("testSocket", { message: "realtime updates !!" });
  });

  socket.on(
    "updateProfile",
    async (data: { name: string; avatar?: string }) => {
      try {
        const userId = socket.data.userId;

        const updatedUser = await User.findByIdAndUpdate(
          userId,
          { name: data.name, avatar: data.avatar },
          { new: true },
        );

        if (!updatedUser) {
          return socket.emit("updateProfile", {
            success: false,
            message: "User not found",
          });
        }

        const newToken = generateToken(updatedUser);

        socket.emit("updateProfile", {
          success: true,
          data: { token: newToken },
          message: "Profile updated successfully",
        });
      } catch (error) {
        console.log("updateProfile error:", error);
        socket.emit("updateProfile", {
          success: false,
          message: "Failed to update profile",
        });
      }
    },
  );
  socket.on("getContacts", async () => {
    try {
      const currentUserId = socket.data.userId;
      if (!currentUserId) {
        socket.emit("getContacts", {
          success: false,
          message: "Unauthorized",
        });
        return;
      }
      const users = await User.find(
        { _id: { $ne: currentUserId } },
        { password: 0 },
      ).lean();

      const contacts = users.map((user) => ({
        id: user._id.toString(),
        name: user.name,
        avatar: user.avatar || "",
        email: user.email,
      }));
      socket.emit("getContacts", {
        success: true,
        data: contacts,
      });
    } catch (error) {
      console.log("getContacts error:", error);
      socket.emit("getContacts", {
        success: false,
        message: "Failed to fetch contacts",
      });
    }
  });
  return io;
}
