import { useEffect } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import { tokenStore } from '../api/client';
import { useAuthStore } from '../store/auth';

/**
 * 实时协作通道。
 *
 * 收到的每个事件只做一件事：让相关查询失效并重取。
 * 这样做的好处是前端永远只有一个数据真相（服务端），
 * 不会出现"本地状态和他人改动打架"的情况。
 */
export function useRealtime(): void {
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!user) return;

    const socket: Socket = io('/', {
      path: '/ws',
      auth: { token: tokenStore.access },
      transports: ['websocket', 'polling'],
    });

    const invalidate = (keys: unknown[]) => {
      for (const key of keys) void queryClient.invalidateQueries({ queryKey: key as string[] });
    };

    socket.on('vague_item:new', () => {
      invalidate([['vague-items'], ['recipe'], ['recipes'], ['vague-summary']]);
    });
    socket.on('vague_item:updated', () => {
      invalidate([['vague-items'], ['vague-item'], ['recipe'], ['recipes'], ['vague-summary']]);
    });
    socket.on('comment:created', () => invalidate([['comments']]));
    socket.on('version:published', () => invalidate([['versions'], ['recipe'], ['recipes']]));
    socket.on('verification:submitted', () => {
      invalidate([['verifications'], ['vague-items'], ['recipe'], ['recipes']]);
    });
    socket.on('audio:created', () => invalidate([['audio']]));
    socket.on('notification:new', () => invalidate([['notifications']]));
    // 家族话术被整理者增删改后，所有开着追问台 / 话术页的成员即时刷新
    socket.on('question_template:changed', () =>
      invalidate([['question-templates'], ['question-templates-usable']]),
    );

    return () => {
      socket.close();
    };
  }, [user, queryClient]);
}
