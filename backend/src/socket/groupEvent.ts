import type { Socket, Server as SocketIOServer } from "socket.io";
import Conversation from "../modals/Conversation.js";
import Message from "../modals/Message.js";
import { areFriends } from "./friendEvent.js";

const idOf = (v: any) => (v?._id ?? v)?.toString();
const IMAGE_REGEX = /\.(jpe?g|png|gif|webp|heic)(\?.*)?$/i;
export function registerGroupEvents(io: SocketIOServer, socket: Socket) {
  const me = () => socket.data.userId as string;

  const loadConversation = async (conversationId: string) => {
    const c = await Conversation.findById(conversationId);
    if (!c) throw new Error("Conversation not found");
    if (!c.participants.some((p: any) => idOf(p) === me()))
      throw new Error("Not a participants");
    return c;
  };

  const isLeader = (c: any, uid: string) => idOf(c.createdBy) === uid;
  const isAdmin = (c: any, uid: string) =>
    (c.admins || []).some((a: any) => idOf(a) === uid);
  const notifyUpdated = (conversationId: string) =>
    io.to(conversationId).emit("conversationUpdated", {
      success: true,
      data: { conversationId },
    });
  socket.on("getConversationInfo", async (data: { conversationId: string }) => {
    try {
      await loadConversation(data.conversationId);
      const conv: any = await Conversation.findById(data.conversationId)
        .populate({ path: "participants", select: "name avatar email" })
        .lean();
      const images = await Message.find({
        conversationId: data.conversationId,
        attachment: { $regex: IMAGE_REGEX },
      })
        .sort({ createdAt: -1 })
        .select("attachment createdAt")
        .lean();

      socket.emit("getConversationInfo", {
        success: true,
        data: {
          id: conv._id.toString(),
          type: conv.type,
          name: conv.name,
          avatar: conv.avatar,
          createdBy: idOf(conv.createdBy),
          admins: (conv.admins || []).map(idOf),
          participants: conv.participants.map((p: any) => ({
            id: p._id.toString(),
            name: p.name,
            avatar: p.avatar,
            email: p.email,
          })),
          images: images.map((m: any) => ({
            id: m._id.toString(),
            url: m.attachment,
            createdAt: m.createdAt,
          })),
        },
      });
    } catch (error) {
      console.log("getConversationInfo error: ", error);
      socket.emit("getConversationInfo", {
        success: false,
        message: "Không thể tải thông tin",
      });
    }
  });

  socket.on(
    "removeMember",
    async (data: { conversationId: string; userId: string }) => {
      try {
        const c = await loadConversation(data.conversationId);
        if (c.type !== "group") throw new Error("Not a group");
        const target = data.userId;
        const actorIsLeader = isLeader(c, me());
        const actorIsAdmin = isAdmin(c, me());

        if (target === me()) throw new Error("User leaveGroup");
        if (isLeader(c, target)) throw new Error("Can not remove leader");
        if (!actorIsLeader) {
          if (!actorIsAdmin) throw new Error("No permission");
          if (isAdmin(c, target)) throw new Error("No permission");
        }
        await Conversation.findByIdAndUpdate(data.conversationId, {
          $pull: { participants: target, admins: target },
        });
        io.to(`user:${target}`).emit("removedFromConversation", {
          success: true,
          data: { conversationId: data.conversationId },
        });
        io.in(`user:${target}`).socketsLeave(data.conversationId);
        notifyUpdated(data.conversationId);
        socket.emit("removeMember", { success: true });
      } catch (error) {
        console.log("removeMember error: ", error);
        socket.emit("removeMember", {
          success: false,
          message: "Bạn không có quyền thực hiện thao tác này",
        });
      }
    },
  );

  socket.on(
    "setAdmin",
    async (data: {
      conversationId: string;
      userId: string;
      isAdmin: boolean;
    }) => {
      try {
        const c = await loadConversation(data.conversationId);
        if (c.type !== "group" || !isLeader(c, me()))
          throw new Error("No permission");
        if (isLeader(c, data.userId)) throw new Error("Leader is already top");
        if (!c.participants.some((p: any) => idOf(p) === data.userId))
          throw new Error("Not a member");

        await Conversation.findByIdAndUpdate(
          data.conversationId,
          data.isAdmin
            ? { $addToSet: { admins: data.userId } }
            : { $pull: { admins: data.userId } },
        );
        notifyUpdated(data.conversationId);
        socket.emit("setAdmin", { success: true });
      } catch (e) {
        console.log("setAdmin error:", e);
        socket.emit("setAdmin", {
          success: false,
          message: "Chỉ trưởng nhóm mới có quyền phân quyền",
        });
      }
    },
  );

  socket.on("leaveGroup", async (data: { conversationId: string }) => {
    try {
      const c = await loadConversation(data.conversationId);
      if (c.type !== "group") throw new Error("Not a group");
      const remaining = c.participants
        .map(idOf)
        .filter((p: string) => p !== me());

      if (remaining.length === 0) {
        await Message.deleteMany({ conversationId: data.conversationId });
        await Conversation.findByIdAndDelete(data.conversationId);
      } else {
        const update: any = { $pull: { participants: me() } };
        if (isLeader(c, me())) {
          const adminIds = (c.admins || []).map(idOf);
          const newLeader =
            adminIds.find((a: string) => remaining.includes(a)) ?? remaining[0];
          update.$set = { createdBy: newLeader };
          update.$pullAll = { admins: [me(), newLeader] };
        } else {
          update.$pullAll = { admins: [me()] };
        }
        await Conversation.findByIdAndUpdate(data.conversationId, update);
        notifyUpdated(data.conversationId);
      }
      io.in(`user:${me()}`).socketsLeave(data.conversationId);
      socket.emit("leaveGroup", {
        success: true,
        data: { conversationId: data.conversationId },
      });
    } catch (e) {
      console.log("leaveGroup error:", e);
      socket.emit("leaveGroup", {
        success: false,
        message: "Không thể rời nhóm",
      });
    }
  });

  socket.on(
    "addMembers",
    async (data: { conversationId: string; userIds: string[] }) => {
      const fail = (message: string) => {
        socket.emit("addMembers", { success: false, message });
      };
      try {
        const c = await loadConversation(data.conversationId);
        if(c.type !== "group") return fail("Đây không phải nhóm");

        if(!isLeader(c, me()) && !isAdmin(c, me())){
          return fail("Bạn không có quyền thêm thành viên")
        }
        const existing = new Set(c.participants.map(idOf));
        const ids = Array.from(
          new Set((data.userIds || []).map(String)),
        ).filter((id) => !existing.has(id));
        if (ids.length === 0) return fail("Không có thành viên mới để thêm");

        const ok = await Promise.all(ids.map((id) => areFriends(me(), id)));
        if (ok.some((v) => !v)) return fail("Chỉ có thể thêm bạn bè vào nhóm");

        await Conversation.findByIdAndUpdate(data.conversationId, {
          $addToSet: { participants: { $each: ids } },
        });

        ids.forEach((uid) => {
          io.in(`user:${uid}`).socketsJoin(data.conversationId);
          io.to(`user:${uid}`).emit("addedToConversation", {
            success: true,
            data: { conversationId: data.conversationId },
          });
        });
        notifyUpdated(data.conversationId); 

        socket.emit("addMembers", {
          success: true,
          data: { added: ids.length },
        });
      } catch (error: any) {
         console.log("addMembers error:", error);
         fail("Không thể thêm thành viên");
      }
    },
  );
}
