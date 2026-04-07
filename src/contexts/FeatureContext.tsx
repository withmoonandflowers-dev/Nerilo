import React, { createContext, useContext, useEffect, useState } from 'react';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { db } from '../config/firebase';
import { useAuth } from './AuthContext';
import type { Feature, UserRole } from '../types';

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
    // 無論 user 是否存在，都確保返回 cleanup function（#23）
    let unsubscribe: (() => void) | null = null;

    if (!user) {
      setFeatures([]);
      setLoading(false);
    } else {
      const featuresRef = collection(db, 'features');
      const q = query(featuresRef, where('enabled', '==', true));

      unsubscribe = onSnapshot(q, (snapshot) => {
        const featureList: Feature[] = [];
        snapshot.forEach((doc) => {
          const data = doc.data();
          const feature: Feature = {
            featureId: doc.id,
            name: data.name,
            description: data.description,
            enabled: data.enabled,
            requiredRoles: data.requiredRoles || [],
            route: data.route,
            icon: data.icon,
            createdAt: data.createdAt?.toMillis() || Date.now(),
            updatedAt: data.updatedAt?.toMillis() || Date.now(),
          };

          // RBAC 過濾：檢查使用者是否有權限
          if (hasPermission(user.role, feature.requiredRoles)) {
            featureList.push(feature);
          }
        });

        setFeatures(featureList);
        setLoading(false);
      });
    }

    return () => { unsubscribe?.(); };
  }, [user]);

  const hasPermission = (userRole: UserRole, requiredRoles: UserRole[]): boolean => {
    if (requiredRoles.length === 0) return true;
    return requiredRoles.includes(userRole);
  };

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



