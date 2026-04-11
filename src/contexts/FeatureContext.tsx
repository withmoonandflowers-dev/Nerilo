import React, { createContext, useContext, useEffect, useState } from 'react';
import { useAuth } from './AuthContext';
import type { Feature } from '../types';

// TODO: Migrate to Firebase Remote Config

interface FeatureContextType {
  features: Feature[];
  loading: boolean;
  searchFeatures: (keyword: string) => Feature[];
}

const FeatureContext = createContext<FeatureContextType | undefined>(undefined);

export const FeatureProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  const [features, setFeatures] = useState<Feature[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // TODO: Migrate to Firebase Remote Config
    setFeatures([]);
    setLoading(false);
  }, [user]);

  // TODO: Restore RBAC filtering (hasPermission) when migrated to Firebase Remote Config

  const searchFeatures = (keyword: string): Feature[] => {
    if (!keyword.trim()) return features;

    const lowerKeyword = keyword.toLowerCase();
    return features.filter((feature) => {
      const nameMatch = feature.name.toLowerCase().includes(lowerKeyword);
      const descMatch = feature.description.toLowerCase().includes(lowerKeyword);
      return nameMatch || descMatch;
    });
  };

  return (
    <FeatureContext.Provider value={{ features, loading, searchFeatures }}>
      {children}
    </FeatureContext.Provider>
  );
};

export const useFeatures = (): FeatureContextType => {
  const context = useContext(FeatureContext);
  if (context === undefined) {
    throw new Error('useFeatures must be used within a FeatureProvider');
  }
  return context;
};
