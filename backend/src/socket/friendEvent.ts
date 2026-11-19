import type { Socket, Server as SocketIOServer } from "socket.io";
import Friendship from "../modals/Friendship.js";
import User from "../modals/User.js";

export type FriendStatus = "self" | "none" | "friend" | "sent" | "received";

export async function getFriendStatusBetween(
  me: string,
  other: string,
): Promise<{ status: FriendStatus; requestId?: string }> {
  if (me === other) return { status: "self" };
  const f = await Friendship.findOne({
    $or: [
      { requester: me, recipient: other },
      { requester: other, recipient: me },
    ],
  }).lean();
  if (!f) return { status: "none" };
  const requestId = f._id.toString();
  if (f.status === "accepted") return { status: "friend", requestId };
  if (f.requester.toString() === me) return { status: "sent", requestId };
  return { status: "received", requestId };
}
export async function areFriends(a: string, b: string) {
  return (await getFriendStatusBetween(a, b)).status === "friend";
}

export function registerFriendEvents(io: SocketIOServer, socket: Socket) {
  const me = () => socket.data.userId as string;

  socket.on("searchUserByEmail", async (data: { email: string }) => {
    try {
      const email = String(data?.email || "")
        .trim()
        .toLowerCase();
      if (!email) {
        socket.emit("searchUserByEmail", {
          success: false,
          message: "Vui lòng nhập email",
        });
        return;
      }

      const user = await User.findOne({ email })
        .select("_id name avatar email")
        .lean();
      if (!user) {
        socket.emit("searchUserByEmail", {
          success: false,
          message: "Không tìm thấy người dùng",
        });
        return;
      }

      const id = user._id.toString();
      if (id === me()) {
        socket.emit("searchUserByEmail", {
          success: false,
          message: "Không thể tìm kiếm chính mình",
        });
        return;
      }
      const { status, requestId } = await getFriendStatusBetween(me(), id);

      socket.emit("searchUserByEmail", {
        success: true,
        data: {
          id,
          _id: id,
          name: user.name,
          avatar: user.avatar,
          email: user.email,
          status,
          requestId,
        },
      });
    } catch (error) {
      console.log("searchUserByEmail error:", error);
      socket.emit("searchUserByEmail", {
        success: false,
        message: "Không thể tìm kiếm",
      });
    }
  });
  socket.on("searchFriendByEmail", async (data: { email: string }) => {
    try {
      const email = String(data?.email || "")
        .trim()
        .toLowerCase();
      if (!email) {
        socket.emit("searchFriendByEmail", {
          success: false,
          message: "Vui lòng nhập email",
        });
        return;
      }

      const user = await User.findOne({ email })
        .select("_id name avatar email")
        .lean();
      if (!user) {
        socket.emit("searchFriendByEmail", {
          success: false,
          message: "Không tìm thấy người dùng",
        });
        return;
      }

      const userId = user._id.toString();
      if (userId === me()) {
        socket.emit("searchFriendByEmail", {
          success: false,
          message: "Không thể tìm kiếm chính mình",
        });
        return;
      }

      if (!(await areFriends(me(), userId))) {
        socket.emit("searchFriendByEmail", {
          success: false,
          message: "Người dùng này chưa phải bạn bè của bạn",
        });
        return;
      }

      socket.emit("searchFriendByEmail", {
        success: true,
        data: {
          id: userId,
          _id: userId,
          name: user.name,
          avatar: user.avatar,
          email: user.email,
          status: "friend",
          requestId: null,
        },
      });
    } catch (error) {
      console.log("searchFriendByEmail error:", error);
      socket.emit("searchFriendByEmail", {
        success: false,
        message: "Không thể tìm kiếm",
      });
    }
  });

  socket.on("getFriends", async () => {
    try {
      const list = await Friendship.find({
        status: "accepted",
        $or: [{ requester: me() }, { recipient: me() }],
      })
        .populate({ path: "requester", select: "name avatar email" })
        .populate({ path: "recipient", select: "name avatar email" })
        .lean();
      const friends = list
        .map((f: any) => {
          if (!f.requester || !f.recipient) return null;
          const other =
            f.requester._id.toString() === me() ? f.recipient : f.requester;
          const id = other._id.toString();
          return {
            id,
            _id: id,
            name: other.name,
            avatar: other.avatar,
            email: other.email,
          };
        })
        .filter(Boolean);

      socket.emit("getFriends", { success: true, data: friends });
    } catch (error) {
      console.log("getFriends error:", error);
      socket.emit("getFriends", {
        success: false,
        message: "Không thể tải danh sách bạn bè",
      });
    }
  });

  socket.on("sendFriendRequest", async (data: { userId: string }) => {
    try {
      const target = data?.userId;
      if (!target || target === me()) throw new Error("Invalid user");
      const exists = await User.exists({ _id: target });
      if (!exists) throw new Error("User not found");

      const cur = await getFriendStatusBetween(me(), target);

      if (cur.status === "received") {
        await Friendship.findByIdAndUpdate(cur.requestId, {
          status: "accepted",
        });
        io.to(`user:${me()}`).emit("friendStatusChanged", {
          success: true,
          data: { userId: target, status: "friend" },
        });
        io.to(`user:${target}`).emit("friendStatusChanged", {
          success: true,
          data: { userId: me(), status: "friend" },
        });
        socket.emit("sendFriendRequest", {
          success: true,
          data: { userId: target, status: "friend" },
        });
        return;
      }
      if (cur.status === "friend" || cur.status === "sent") {
        socket.emit("sendFriendRequest", {
          success: true,
          data: {
            userId: target,
            status: cur.status,
            requestId: cur.requestId,
          },
        });
        return;
      }

      const fr = await Friendship.create({
        requester: me(),
        recipient: target,
      });
      socket.emit("sendFriendRequest", {
        success: true,
        data: { userId: target, status: "sent", requestId: fr._id.toString() },
      });
      io.to(`user:${target}`).emit("friendRequestReceived", {
        success: true,
        data: { requestId: fr._id.toString(), fromUserId: me() },
      });
      io.to(`user:${target}`).emit("friendStatusChanged", {
        success: true,
        data: {
          userId: me(),
          status: "received",
          requestId: fr._id.toString(),
        },
      });
    } catch (error) {
      socket.emit("sendFriendRequest", {
        success: false,
        message: "Không thể gửi lời mời",
      });
    }
  });

  socket.on(
    "respondFriendRequest",
    async (data: { requestId: string; accept: boolean }) => {
      try {
        const fr = await Friendship.findOne({
          _id: data.requestId,
          recipient: me(),
          status: "pending",
        });
        if (!fr) throw new Error("Request not found");
        const requester = fr.requester.toString();

        if (data.accept) {
          fr.status = "accepted";
          await fr.save();
        } else {
          await fr.deleteOne();
        }
        const status = data.accept ? "friend" : "none";
        io.to(`user:${me()}`).emit("friendStatusChanged", {
          success: true,
          data: { userId: requester, status },
        });
        io.to(`user:${requester}`).emit("friendStatusChanged", {
          success: true,
          data: { userId: me(), status },
        });
        socket.emit("respondFriendRequest", {
          success: true,
          data: { requestId: data.requestId, accepted: !!data.accept },
        });
      } catch (e) {
        console.log("respondFriendRequest error:", e);
        socket.emit("respondFriendRequest", {
          success: false,
          message: "Không thể xử lý lời mời",
        });
      }
    },
  );

  socket.on("getFriendRequests", async () => {
    try {
      const list = await Friendship.find({
        recipient: me(),
        status: "pending",
      })
        .sort({ createdAt: -1 })
        .populate({
          path: "requester",
          select: "name avatar email",
        })
        .lean();
      socket.emit("getFriendRequests", {
        success: true,
        data: list.map((f: any) => ({
          requestId: f._id.toString(),
          user: {
            id: f.requester._id.toString(),
            name: f.requester.name,
            avatar: f.requester.avatar,
            email: f.requester.email,
          },
        })),
      });
    } catch (error) {
      socket.emit("getFriendRequests", {
        success: false,
        message: "Không thể tải lời mời",
      });
    }
  });

  socket.on("getFriendStatus", async (data: { userId: string }) => {
    try {
      const r = await getFriendStatusBetween(me(), data.userId);
      socket.emit("getFriendStatus", {
        success: true,
        data: { userId: data.userId, ...r },
      });
    } catch (error) {
      socket.emit("getFriendStatus", {
        success: false,
        message: "Error",
      });
    }
  });
  return io;
}
