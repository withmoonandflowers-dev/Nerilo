/**
 * 服務注入 Context：提供 IRoomService、IChatStorage 等 Port 實例。
 * 預設為真實實作，測試或 Storybook 可覆寫為 Mock。
 */
import React, { createContext, useContext, useMemo } from 'react';
import type { IRoomService, IChatStorage } from '../ports';
import { roomServiceAdapter } from '../services/RoomServiceAdapter';
import { indexedDBService } from '../services/IndexedDBService';

export interface ServicesContextValue {
  roomService: IRoomService;
  chatStorage: IChatStorage;
}

const defaultServices: ServicesContextValue = {
  roomService: roomServiceAdapter,
  chatStorage: indexedDBService,
};

const ServicesContext = createContext<ServicesContextValue>(defaultServices);

export interface ServicesProviderProps {
  children: React.ReactNode;
  /** 可選：覆寫預設服務（測試或可插拔時使用） */
  value?: Partial<ServicesContextValue>;
}

export function ServicesProvider({ children, value }: ServicesProviderProps) {
  const merged = useMemo(
    () => (value ? { ...defaultServices, ...value } : defaultServices),
    [value]
  );
  return (
    <ServicesContext.Provider value={merged}>
      {children}
    </ServicesContext.Provider>
  );
}

export function useServices(): ServicesContextValue {
  const ctx = useContext(ServicesContext);
  if (ctx == null) {
    throw new Error('useServices must be used within ServicesProvider');
  }
  return ctx;
}
