import { MAX_VIEWERS } from "./protocol.js";

export class RoomRegistry {
  constructor() { this.rooms = new Map(); }
  getOrCreate(instanceId) {
    let room = this.rooms.get(instanceId);
    if (!room) {
      room = { instanceId, broadcaster: null, viewers: new Map(), createdAt: Date.now() };
      this.rooms.set(instanceId, room);
    }
    return room;
  }
  hasUser(instanceId, userId) {
    return [...(this.rooms.get(instanceId)?.viewers.values() || [])].some((viewer) => viewer.user?.id === userId);
  }
  addViewer(instanceId, connectionId, viewer) {
    const room = this.getOrCreate(instanceId);
    // One Activity socket per user: reconnects replace a stale connection.
    const previous = [...room.viewers.entries()].find(([, entry]) => entry.user?.id && entry.user.id === viewer.user?.id);
    if (previous) {
      room.viewers.delete(previous[0]);
      previous[1].socket?.close?.(1008, "Activity aberta em outra janela.");
    }
    const projected = [...room.viewers.values(), viewer];
    const owner = room.broadcaster?.user.id;
    const count = new Set(projected.map((entry) => entry.user?.id).filter((id) => id && id !== owner)).size;
    if ((!owner && room.viewers.size >= MAX_VIEWERS + 1) || (owner && count > MAX_VIEWERS)) {
      throw new Error(`Esta transmissão já tem ${MAX_VIEWERS} espectadores.`);
    }
    room.viewers.set(connectionId, viewer);
    return room;
  }
  startBroadcast(instanceId, broadcaster) {
    const room = this.getOrCreate(instanceId);
    if (room.broadcaster && room.broadcaster.connectionId !== broadcaster.connectionId &&
        room.broadcaster.user?.id === broadcaster.user?.id) {
      room.broadcaster = broadcaster;
      return room;
    }
    if (room.broadcaster && room.broadcaster.connectionId !== broadcaster.connectionId) {
      throw new Error("Outra pessoa já está transmitindo nesta instância.");
    }
    const viewers = new Set([...room.viewers.values()].map((v) => v.user?.id).filter((id) => id && id !== broadcaster.user.id));
    if (viewers.size > MAX_VIEWERS) throw new Error(`Esta transmissão já tem mais de ${MAX_VIEWERS} espectadores.`);
    room.broadcaster = broadcaster;
    return room;
  }
  viewerCount(room) {
    return new Set([...room.viewers.values()].map((v) => v.user?.id).filter((id) => id && id !== room.broadcaster?.user.id)).size;
  }
  stopBroadcast(instanceId, connectionId) {
    const room = this.rooms.get(instanceId);
    if (!room || room.broadcaster?.connectionId !== connectionId) return null;
    room.broadcaster = null;
    if (!room.viewers.size) this.rooms.delete(instanceId);
    return room;
  }
  removeConnection(connectionId) {
    for (const [instanceId, room] of this.rooms) {
      const broadcasterStopped = room.broadcaster?.connectionId === connectionId;
      if (broadcasterStopped) room.broadcaster = null;
      const viewerRemoved = room.viewers.delete(connectionId);
      if (!room.broadcaster && !room.viewers.size) this.rooms.delete(instanceId);
      if (broadcasterStopped || viewerRemoved) return { room, broadcasterStopped };
    }
    return null;
  }
}
