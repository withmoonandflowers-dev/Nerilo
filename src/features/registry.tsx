/**
 * 功能路由註冊表：可插拔功能在此註冊 path + 元件，App 依此渲染路由。
 */
import type { ReactNode } from 'react';
import ChatPage from './chat/ChatPage';

export interface FeatureRoute {
  path: string;
  element: ReactNode;
}

/** 由各功能模組註冊的路由（不含登入、Dashboard、等待房等靜態路由） */
export const featureRoutes: FeatureRoute[] = [
  {
    path: '/chat/:roomId',
    element: <ChatPage />,
  },
];
