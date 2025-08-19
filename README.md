# RetroFlow Backend

Local development backend for the RetroFlow collaborative retrospective platform.

## Prerequisites

- Node.js 18+ 
- Docker Desktop (for PostgreSQL and Redis)
- npm or yarn

## Quick Start

1. **Clone and navigate to the backend directory:**
   ```bash
   cd retroflow-backend
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Start the database services:**
   ```bash
   npm run docker:up
   ```

4. **Set up the database:**
   ```bash
   npm run setup
   ```

5. **Start the development server:**
   ```bash
   npm run dev
   ```

The server will be running on `http://localhost:3001`

## Available Scripts

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build the TypeScript project
- `npm run start` - Start the production server
- `npm run docker:up` - Start PostgreSQL and Redis containers
- `npm run docker:down` - Stop and remove containers
- `npm run setup` - Initialize database schema and generate Prisma client
- `npm run db:generate` - Generate Prisma client
- `npm run db:push` - Push schema changes to database
- `npm run db:migrate` - Create and run migrations
- `npm run db:studio` - Open Prisma Studio (database GUI)

## API Endpoints

### Sessions
- `POST /api/sessions` - Create new session
- `POST /api/sessions/join` - Join existing session
- `GET /api/sessions/:sessionId` - Get session details
- `GET /api/sessions/invite/:inviteCode` - Get session by invite code
- `PATCH /api/sessions/:sessionId/phase` - Update session phase

### Participants
- `GET /api/participants/:participantId` - Get participant details
- `PATCH /api/participants/:participantId` - Update participant
- `DELETE /api/participants/:participantId` - Remove participant
- `GET /api/participants/:participantId/responses` - Get participant responses
- `GET /api/participants/:participantId/votes` - Get participant votes

### Health Check
- `GET /health` - Server health status

## WebSocket Events

### Client → Server
- `join_session` - Join a session room
- `change_phase` - Change session phase (host only)
- `typing_indicator` - Broadcast typing status
- `add_response` - Add new response
- `update_response` - Edit existing response
- `drag_response` - Move response during grouping
- `cast_vote` - Vote for grouped responses

### Server → Client
- `session_joined` - Confirmation of joining session
- `participant_joined` - New participant joined
- `participant_left` - Participant disconnected
- `phase_changed` - Session phase updated
- `participant_typing` - Someone is typing
- `response_added` - New response created
- `response_updated` - Response edited
- `response_dragged` - Response moved
- `votes_updated` - Vote counts changed
- `error` - Error message

## Database Schema

The database uses PostgreSQL with the following main tables:

- **sessions** - Retrospective sessions
- **participants** - Session participants  
- **responses** - User input responses
- **groups** - Response groupings
- **votes** - Voting on grouped responses

See `prisma/schema.prisma` for the complete schema definition.

## Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
# Database
DATABASE_URL="postgresql://retroflow:retroflow_dev_password@localhost:5432/retroflow"

# Redis  
REDIS_URL="redis://localhost:6379"

# Server
PORT=3001
NODE_ENV=development

# Session
SESSION_SECRET="your-secret-key"

# CORS
CORS_ORIGIN="http://localhost:3000"
```

## Development

### Database Management

**View database in browser:**
```bash
npm run db:studio
```

**Reset database:**
```bash
npm run docker:down
npm run docker:up
npm run db:push
```

**Create migration:**
```bash
npm run db:migrate
```

### Debugging

The server includes structured logging and error handling. Check the console output for:
- ✅ Successful connections
- 🔌 WebSocket events  
- ❌ Errors and failures

### Testing WebSocket Events

You can test WebSocket functionality using a tool like [wscat](https://github.com/websockets/wscat):

```bash
npm install -g wscat
wscat -c ws://localhost:3001
```

## Production Considerations

For production deployment:

1. Set `NODE_ENV=production`
2. Use a secure `SESSION_SECRET`  
3. Configure proper CORS origins
4. Use managed PostgreSQL and Redis instances
5. Enable SSL/TLS
6. Set up monitoring and logging
7. Configure rate limiting based on your needs

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Frontend      │    │   Backend       │    │   Database      │
│   (React)       │◄──►│   (Node.js)     │◄──►│   (PostgreSQL)  │
│                 │    │                 │    │                 │
│   Socket.io     │◄──►│   Socket.io     │◄──►│   Redis         │
│   Client        │    │   Server        │    │   (Sessions)    │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

The backend handles:
- RESTful API for session management
- Real-time collaboration via WebSocket
- Session state management with Redis
- Data persistence with PostgreSQL
- Authentication and rate limiting