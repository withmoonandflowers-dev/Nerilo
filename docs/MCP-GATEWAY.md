# Nerilo MCP Gateway

Nerilo exposes seven intent-level MCP tools for AI clients:

- `nerilo_get_capabilities`
- `nerilo_create_room`
- `nerilo_join_room`
- `nerilo_send_message`
- `nerilo_get_messages`
- `nerilo_room_status`
- `nerilo_list_rooms`

The tools deliberately describe user intent. Signaling, key exchange, courier routing and storage primitives are not exposed to the model.

## Run the current gateway

```bash
npm install
NERILO_MCP_AGENT_ID=my-stable-agent npm run mcp
```

Generic stdio MCP client configuration:

```json
{
  "mcpServers": {
    "nerilo": {
      "command": "npm",
      "args": ["--prefix", "/absolute/path/to/Nerilo", "run", "mcp"],
      "env": {
        "NERILO_MCP_AGENT_ID": "my-stable-agent",
        "NERILO_MCP_READ_ONLY": "true"
      }
    }
  }
}
```

Supported policy variables:

| Variable | Default | Meaning |
|---|---:|---|
| `NERILO_MCP_AGENT_ID` | random per process | Fixed identity presented by this server. Set it explicitly outside throwaway demos. |
| `NERILO_MCP_READ_ONLY` | `false` | Reject create, join and send operations. |
| `NERILO_MCP_ALLOW_CREATE` | `true` | Independently disable room creation. |
| `NERILO_MCP_ALLOW_JOIN` | `true` | Independently disable joining. |
| `NERILO_MCP_ALLOWED_ROOMS` | unset | Comma-separated room allowlist. When set, all room-scoped calls outside it are rejected. |
| `NERILO_MCP_MAX_MESSAGE_CHARS` | `4000` | Maximum outgoing message length accepted by the tool schema. |

Audit events are JSON lines on stderr. Message bodies are intentionally excluded from audit output.

## Current runtime boundary

The checked-in runtime is `in-process` and is intended for MCP integration tests, contract exploration and demos. It is:

- not networked;
- not persistent across server restarts;
- not encrypted;
- not shared by separately launched MCP processes.

Every AI client can discover this by calling `nerilo_get_capabilities`. Do not describe this runtime as Nerilo P2P or E2EE.

## Production runtime design

The recommended production path is a browser bridge, because the browser already owns the capabilities Node does not: `RTCPeerConnection`, IndexedDB, the authenticated Firebase session, WebCrypto keys and user-visible consent UI.

```text
AI host
  │ stdio MCP
  ▼
Nerilo MCP gateway
  │ authenticated loopback bridge
  ▼
User-approved Nerilo browser tab
  │ NeriloClient
  ├── WebRTC DataChannel / mesh gossip
  ├── WebCrypto E2EE
  ├── IndexedDB
  └── Firestore signaling + encrypted fallback
```

The runtime seam is [`mcp/runtime.ts`](../mcp/runtime.ts). A browser-backed implementation should satisfy `NeriloMcpRuntime`; the MCP tool surface does not need another redesign.

Required security properties for that bridge:

1. Bind only to loopback and pair with a short-lived, high-entropy token shown by the browser UI.
2. Keep Firebase credentials and private keys in the browser; never copy them into the MCP process.
3. Bind one gateway to one fixed Nerilo identity. There is no `as` tool argument.
4. Default to read-only. Create, join and send require explicit browser approval, with an optional remembered room allowlist.
5. Display the exact outgoing text before approval and write an audit event without message content.
6. Treat incoming chat content as untrusted data. It cannot change MCP policy or become a system instruction.
7. Return `messageId` as “accepted for send”, not “delivered”; recipient ACK must be a separate protocol fact.
8. Reject commands while no approved browser session is attached; never silently fall back to plaintext or the in-process runtime.

## Delivery plan

- Phase A — complete here: safe MCP intent surface, fixed identity, policy enforcement, pagination, capability truth and audit hook.
- Phase B — implement an opt-in browser bridge using the existing React app first, then make the reference app consume `NeriloClient` directly.
- Phase C — add recipient ACK and expose it as message status only after it is cryptographically tied to a message ID.
- Phase D — consider remote Streamable HTTP only after OAuth, tenant isolation, quotas, revocation and abuse controls exist. Stdio plus a local browser bridge is the safer first product.
