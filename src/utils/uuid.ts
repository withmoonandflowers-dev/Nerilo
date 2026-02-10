import { v4 as uuidv4 } from 'uuid';

export const generateUUID = (): string => uuidv4();

export const generateDeviceId = (): string => {
  const stored = localStorage.getItem('deviceId');
  if (stored) return stored;
  
  const deviceId = `device_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  localStorage.setItem('deviceId', deviceId);
  return deviceId;
};



