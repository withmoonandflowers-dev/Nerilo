#!/usr/bin/env bash
#
# 設定 Firestore 原生 TTL policy（ADR-0006 附錄：不升級 Blaze 的資料保留方案）。
#
# 原生 TTL policy 是 Firestore 層級功能，Spark（免費）方案即可用，
# 不需要 Cloud Functions、不需要 Blaze。過期文件由 Firestore 自動刪除
# （官方 SLA 最長 72 小時延遲，對清理用途可接受）。
#
# 前置：
#   1. 安裝 gcloud CLI 並登入具 Firestore 管理權限的帳號
#      （gcloud auth login；gcloud config set project nerilo）
#   2. 啟用 Firestore API（免費方案已內含）
#
# 執行：bash scripts/setup-ttl-policies.sh
# 需由專案擁有者手動執行一次（Claude 無 GCP 憑證，無法代跑）。
# 冪等：重複執行只會回報 policy 已存在。

set -euo pipefail

PROJECT="${1:-nerilo}"
DATABASE="(default)"

echo "在專案 ${PROJECT} 設定 Firestore TTL policies..."
echo

# collection group → TTL 欄位。三個集合各自設 TTL，
# 不依賴房間刪除觸發（原生 TTL 不級聯刪子集合，見 ADR-0006 附錄）。
declare -a TTL_TARGETS=(
  "p2pRooms:ttlExpireAt"     # 過期房間（waiting 5min / open 30min）
  "signals:createdAt"        # 信令：靠 collection group，過期即清（配合下方 --collection-group）
  "messages:createdAt"       # fallback 訊息
  "inbox:expiresAt"          # store-and-forward 收件匣（24h）
)

for target in "${TTL_TARGETS[@]}"; do
  COLLECTION="${target%%:*}"
  FIELD="${target##*:}"
  echo "→ ${COLLECTION}.${FIELD}"
  gcloud firestore fields ttls update "${FIELD}" \
    --collection-group="${COLLECTION}" \
    --project="${PROJECT}" \
    --database="${DATABASE}" \
    --enable-ttl \
    --async || echo "  （已存在或需人工確認，略過）"
done

echo
echo "完成。查詢現有 TTL 設定："
echo "  gcloud firestore fields ttls list --collection-group=p2pRooms --project=${PROJECT}"
echo
echo "注意：signals/messages/inbox 是子集合，上面用 collection-group 設定會涵蓋"
echo "所有房間下的同名子集合。createdAt 需為 Timestamp 型別（rules 允許 number"
echo "或 Timestamp，但 TTL policy 只對 Timestamp 生效——number 型的舊文件不會被"
echo "自動清，靠自然汰換或一次性遷移）。"
