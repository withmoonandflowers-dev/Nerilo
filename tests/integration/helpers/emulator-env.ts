/**
 * Emulator 環境變數設定
 *
 * 必須在 firebase-admin / firebase SDK 初始化之前設定，
 * 因此作為 vitest setupFiles 最早執行。
 *
 * Firebase SDK 偵測這些變數的時機是模組 import 時，所以
 * 放在 setupFiles 而非 beforeAll / beforeEach 中。
 */

// Firestore Emulator（Admin SDK + Web SDK 共用此環境變數）
process.env['FIRESTORE_EMULATOR_HOST'] = '127.0.0.1:8080';

// Auth Emulator
process.env['FIREBASE_AUTH_EMULATOR_HOST'] = '127.0.0.1:9099';

// 避免 firebase-admin 嘗試讀取 Application Default Credentials
process.env['GOOGLE_APPLICATION_CREDENTIALS'] = '';
