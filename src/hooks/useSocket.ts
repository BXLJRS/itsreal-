import { useEffect, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

export const useSocket = (roomId: string) => {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!socket) {
      socket = io();
    }

    socket.on('connect', () => {
      setConnected(true);
      socket?.emit('join_room', roomId);
    });

    socket.on('disconnect', () => {
      setConnected(false);
    });

    return () => {
      // We don't necessarily want to disconnect on every unmount if we're just switching components
      // but for this app, we'll keep it simple.
    };
  }, [roomId]);

  const emit = useCallback((event: string, data: any) => {
    socket?.emit(event, { ...data, roomId });
  }, [roomId]);

  const on = useCallback((event: string, callback: (data: any) => void) => {
    socket?.on(event, callback);
    return () => {
      socket?.off(event, callback);
    };
  }, []);

  return { socket, connected, emit, on };
};
