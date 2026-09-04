import { MAX_VIEWERS } from "./protocol.js";

export class RoomRegistry {
  constructor() {
    this.rooms = new Map();
  }

  getOrCreate(instanceId) {
    let room = this.rooms.get(instanceId);
    if (!room) {
      room = { instanceId, broadcaster: null, viewers: new Map(), createdAt: Date.now(), initSegment: null };
      this.rooms.set(instanceId, room);
    }
    return room;
  }

  addViewer(instanceId, connectionId, viewer) {
    const room = this.getOrCreate(instanceId);
    // Antes de existir broadcaster, uma das seis Activities poderá se tornar o
    // transmissor. Depois disso, contam-se até cinco pessoas além dele.
    const projected = [...room.viewers.values(), viewer];
    const broadcasterId = room.broadcaster?.user.id;
    const viewerIds = new Set(projected.map((entry) => entry.user?.id).filter((id) => id && id !== broadcasterId));
    if ((!broadcasterId && room.viewers.size >= MAX_VIEWERS + 1) || (broadcasterId && viewerIds.size > MAX_VIEWERS)) {
      throw new Error(`Esta transmissão já tem ${MAX_VIEWERS} espectadores.`);
    }
    room.viewers.set(connectionId, viewer);
    return room;
  }

  startBroadcast(instanceId, broadcaster) {
    const room = this.getOrCreate(instanceId);
    if (room.broadcaster && room.broadcaster.connectionId !== broadcaster.connectionId) {
      throw new Error("Outra pessoa já está transmitindo nesta instância.");
    }
    const viewerIds = new Set([...room.viewers.values()].map((viewer) => viewer.user?.id).filter((id) => id && id !== broadcaster.user.id));
    if (viewerIds.size > MAX_VIEWERS) throw new Error(`Esta transmissão já tem mais de ${MAX_VIEWERS} espectadores.`);
    room.broadcaster = broadcaster;
    room.initSegment = null;
    return room;
  }

  viewerCount(room) {
    const broadcasterId = room.broadcaster?.user.id;
    return new Set([...room.viewers.values()].map((viewer) => viewer.user?.id).filter((id) => id && id !== broadcasterId)).size;
  }

  stopBroadcast(instanceId, connectionId) {
    const room = this.rooms.get(instanceId);
    if (!room || room.broadcaster?.connectionId !== connectionId) return null;
    room.broadcaster = null;
    room.initSegment = null;
    if (room.viewers.size === 0) this.rooms.delete(instanceId);
    return room;
  }

  removeConnection(connectionId) {
    for (const [instanceId, room] of this.rooms) {
      let broadcasterStopped = false;
      if (room.broadcaster?.connectionId === connectionId) {
        room.broadcaster = null;
        room.initSegment = null;
        broadcasterStopped = true;
      }
      const viewerRemoved = room.viewers.delete(connectionId);
      if (!room.broadcaster && room.viewers.size === 0) this.rooms.delete(instanceId);
      if (broadcasterStopped || viewerRemoved) return { room, broadcasterStopped };
    }
    return null;
  }
}
