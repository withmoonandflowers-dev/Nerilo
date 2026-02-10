# 新功能接入 SOP

本文檔說明如何在 Nerilo 平台中新增自訂功能，並透過 P2P 傳輸資料。

## 前置條件

1. 已登入 Firebase Console
2. 具有 admin 權限（用於註冊功能）
3. 熟悉 React + TypeScript
4. 了解 P2P 協議設計（參考協議文件）

## 步驟 1：定義功能協議

### 1.1 決定 Namespace

選擇一個唯一的 namespace，格式：`feature.<name>`

範例：
- `feature.crm`
- `feature.analytics`
- `feature.collaboration`

### 1.2 定義 Types

列出所有需要的訊息類型：

```typescript
const types = [
  'CONTACT_CREATE',
  'CONTACT_UPDATE',
  'CONTACT_DELETE',
  'NOTE_ADD',
];
```

### 1.3 定義 Payload Schema

為每個 type 定義 payload 結構：

```typescript
interface ContactCreatePayload {
  contactId: string;
  name: string;
  email: string;
  phone?: string;
}

interface ContactUpdatePayload {
  contactId: string;
  fields: Record<string, any>;
}
```

## 步驟 2：實作功能 Handler

### 2.1 建立功能服務類別

建立 `src/features/<feature-name>/<FeatureName>Service.ts`：

```typescript
import { P2PChannelBus } from '../../../core/p2p/P2PChannelBus';
import { P2PProtocolRegistry } from '../../../core/p2p/P2PProtocolRegistry';
import type { P2PEnvelope } from '../../../types';
import { generateUUID } from '../../../utils/uuid';

export class CRMService {
  private channelBus: P2PChannelBus;
  private localUid: string;
  private deviceId: string;

  constructor(
    channelBus: P2PChannelBus,
    localUid: string,
    deviceId: string
  ) {
    this.channelBus = channelBus;
    this.localUid = localUid;
    this.deviceId = deviceId;
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.channelBus.subscribe('feature.crm', async (envelope) => {
      await this.handleMessage(envelope);
    });
  }

  private async handleMessage(envelope: P2PEnvelope): Promise<void> {
    switch (envelope.type) {
      case 'CONTACT_CREATE':
        await this.handleContactCreate(envelope.payload);
        break;
      case 'CONTACT_UPDATE':
        await this.handleContactUpdate(envelope.payload);
        break;
      // ... 其他 types
    }
  }

  async createContact(name: string, email: string): Promise<string> {
    const contactId = generateUUID();
    const envelope: P2PEnvelope = {
      v: 1,
      ns: 'feature.crm',
      type: 'CONTACT_CREATE',
      id: generateUUID(),
      ts: Date.now(),
      from: `${this.localUid}/${this.deviceId}`,
      payload: {
        contactId,
        name,
        email,
      },
    };

    await this.channelBus.send(envelope);
    return contactId;
  }

  private async handleContactCreate(payload: any): Promise<void> {
    // 處理接收到的聯絡人建立訊息
    console.log('Contact created:', payload);
    // 更新 UI、儲存到 IndexedDB 等
  }
}
```

### 2.2 註冊協議

在功能初始化時註冊協議：

```typescript
import { P2PProtocolRegistry } from '../../../core/p2p/P2PProtocolRegistry';

const registry = p2pManager.getProtocolRegistry();

registry.register({
  namespace: 'feature.crm',
  types: ['CONTACT_CREATE', 'CONTACT_UPDATE', 'CONTACT_DELETE', 'NOTE_ADD'],
  validator: (payload) => {
    // 驗證 payload
    if (payload.contactId && typeof payload.contactId === 'string') {
      return true;
    }
    return false;
  },
}, async (envelope) => {
  // 可選：全域 handler
  console.log('CRM message received:', envelope);
});
```

## 步驟 3：建立 UI 元件

### 3.1 建立功能頁面

建立 `src/features/<feature-name>/<FeatureName>Page.tsx`：

```typescript
import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { CRMService } from './CRMService';
import { P2PManager } from '../../core/p2p/P2PManager';
import { generateDeviceId } from '../../utils/uuid';

const CRMPage: React.FC = () => {
  const { roomId } = useParams<{ roomId: string }>();
  const { user } = useAuth();
  const [p2pManager, setP2PManager] = useState<P2PManager | null>(null);
  const [crmService, setCrmService] = useState<CRMService | null>(null);

  useEffect(() => {
    if (!user || !roomId) return;

    const init = async () => {
      const deviceId = generateDeviceId();
      const manager = new P2PManager(roomId, user.uid);
      await manager.initialize();

      const channelBus = manager.getChannelBus();
      if (channelBus) {
        const service = new CRMService(channelBus, user.uid, deviceId);
        setCrmService(service);
      }

      setP2PManager(manager);
    };

    init();

    return () => {
      p2pManager?.close();
    };
  }, [user, roomId]);

  const handleCreateContact = async () => {
    if (!crmService) return;
    await crmService.createContact('John Doe', 'john@example.com');
  };

  return (
    <div>
      <h1>CRM 功能</h1>
      <button onClick={handleCreateContact}>建立聯絡人</button>
    </div>
  );
};

export default CRMPage;
```

## 步驟 4：註冊功能到 Firestore

### 4.1 在 Firestore 建立功能文件

在 Firebase Console 或透過 Cloud Functions 建立：

```typescript
// Firestore: features/{featureId}
{
  featureId: 'crm',
  name: 'CRM 管理',
  description: '客戶關係管理功能',
  enabled: true,
  requiredRoles: ['user', 'admin'],
  route: '/crm/:roomId',
  icon: '👥',
  createdAt: Timestamp.now(),
  updatedAt: Timestamp.now(),
}
```

### 4.2 更新路由

在 `src/App.tsx` 新增路由：

```typescript
import CRMPage from './features/crm/CRMPage';

// 在 Routes 中新增
<Route
  path="/crm/:roomId"
  element={
    <ProtectedRoute>
      <CRMPage />
    </ProtectedRoute>
  }
/>
```

## 步驟 5：測試

### 5.1 功能測試

1. 登入系統
2. 確認功能出現在 Dashboard
3. 建立 P2P 房間
4. 測試功能收發訊息
5. 驗證資料不寫入 Firestore（僅 P2P）

### 5.2 協議驗證測試

1. 發送錯誤格式的訊息
2. 確認收到 `system.ERROR`
3. 測試未註冊的 namespace
4. 確認驗證機制正常運作

## 步驟 6：文件化

### 6.1 更新協議文件

在 `docs/協議文件.md` 中新增功能協議說明。

### 6.2 更新架構文件

如有架構變更，更新 `docs/架構文件.md`。

## 常見問題

### Q: 如何處理大量資料？

A: 使用分片機制（參考 file 協議），或使用多個 Envelope 分批傳送。

### Q: 如何確保訊息順序？

A: DataChannel 設定 `ordered: true`，或使用 `ts` 時間戳排序。

### Q: 如何處理離線訊息？

A: 本系統不支援離線訊息。僅支援同時在線的 P2P 同步。

### Q: 如何擴充現有功能？

A: 在現有 namespace 中新增 type，或建立新的 namespace。

## 檢查清單

- [ ] 定義 namespace 與 types
- [ ] 實作功能服務類別
- [ ] 註冊協議到 P2PProtocolRegistry
- [ ] 建立 UI 元件
- [ ] 在 Firestore 註冊功能
- [ ] 更新路由
- [ ] 測試功能
- [ ] 更新文件

## 範例專案

參考 `src/features/chat/` 作為完整範例。


