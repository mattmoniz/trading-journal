# Trading Journal Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Trading Journal App                       │
└─────────────────────────────────────────────────────────────┘

┌──────────────────────┐         ┌──────────────────────┐
│   React Frontend     │ ◄─────► │   Express Backend    │
│   (Port 3000)        │  HTTP   │   (Port 3001)        │
│                      │         │                      │
│  - Today's Log       │         │  - REST API          │
│  - Calendar View     │         │  - File Upload       │
│  - Dashboard         │         │  - Query Logic       │
│  - Settings          │         │                      │
└──────────────────────┘         └──────────┬───────────┘
                                            │
                                            │ SQL
                                            ▼
                                 ┌──────────────────────┐
                                 │   PostgreSQL DB      │
                                 │   (Port 5432)        │
                                 │                      │
                                 │  - daily_logs        │
                                 │  - trades            │
                                 │  - screenshots       │
                                 │  - setup_types       │
                                 │  - custom_fields     │
                                 └──────────────────────┘
```

## Technology Stack

### Frontend
- **React 18**: UI library
- **Vite**: Build tool and dev server
- **CSS3**: Custom styling with CSS variables

### Backend
- **Express**: Web server framework
- **Node.js**: JavaScript runtime
- **Multer**: File upload handling
- **pg**: PostgreSQL client

### Database
- **PostgreSQL 14+**: Relational database
- **JSONB**: Flexible custom fields
- **Views**: Pre-computed analytics
- **Triggers**: Auto-update timestamps

## Data Flow

### Creating a Trade

```
User fills form → React state updates → POST /api/trades
                                              ↓
                                         Express route
                                              ↓
                                    INSERT into trades table
                                              ↓
                                         Return trade
                                              ↓
                                      React updates UI
```

### Viewing Dashboard

```
Dashboard loads → GET /api/stats/overview
                  GET /api/stats/daily
                  GET /api/stats/by-setup
                           ↓
                    Execute SQL queries
                           ↓
                    Aggregate data from:
                    - trades table
                    - daily_performance view
                           ↓
                    Return JSON stats
                           ↓
                    Render charts & metrics
```

## File Structure

```
trading-journal/
├── server/
│   ├── index.js              # Express server
│   ├── db.js                 # PostgreSQL connection
│   ├── schema.sql            # Database schema
│   ├── scripts/
│   │   └── setupDb.js        # DB initialization
│   └── uploads/              # Trade screenshots
│
├── src/
│   ├── main.jsx              # React entry point
│   ├── App.jsx               # Main React component
│   ├── App.css               # Styling
│   └── index.css             # Base styles
│
├── package.json              # Dependencies & scripts
├── vite.config.js            # Vite configuration
├── .env.example              # Environment template
└── README.md                 # Documentation
```

## Database Schema Relationships

```
daily_logs (1) ───┐
                  │
                  │ log_date
                  │
                  ├─────► trades (many)
                  │           │
                  │           │ trade_id
                  │           │
                  │           └─────► trade_screenshots (many)
                  │
                  └─────► Aggregated in daily_performance view
```

## API Endpoints Structure

```
/api
├── /daily-logs
│   ├── GET /:date              # Get/create log for date
│   ├── PUT /:date              # Update log
│   └── GET /                   # List all logs with stats
│
├── /trades
│   ├── GET /:date              # Get trades for date
│   ├── POST /                  # Create trade
│   ├── PUT /:id                # Update trade
│   ├── DELETE /:id             # Delete trade
│   └── POST /:id/screenshots   # Upload screenshot
│
├── /stats
│   ├── GET /overview           # Overall statistics
│   ├── GET /daily              # Daily performance
│   └── GET /by-setup           # Performance by setup
│
└── /setup-types
    └── GET /                   # List all setups
```

## Key Features Implementation

### Real-time Trade Tracking
- React state management for immediate UI updates
- Optimistic updates with error rollback
- Auto-refresh stats after trade changes

### Flexible Custom Fields
- JSONB column in PostgreSQL
- Store any additional trade data
- No schema changes needed

### Performance Analytics
- SQL views for pre-computed metrics
- Indexed queries for fast retrieval
- Aggregation at database level

### File Uploads
- Multer middleware for handling images
- Stored in server/uploads/
- Linked to trades via trade_screenshots table

## Scalability Considerations

### Current Design (Single User)
- Local PostgreSQL database
- Direct file system storage
- Single-threaded Node.js

### Future Scaling Options
1. **Multi-user Support**
   - Add authentication (JWT/Passport)
   - User table with relationships
   - Row-level security in PostgreSQL

2. **Cloud Deployment**
   - Host on AWS/Heroku/DigitalOcean
   - Use managed PostgreSQL (RDS/Supabase)
   - S3 for screenshot storage

3. **Performance Optimization**
   - Redis caching for frequent queries
   - Database connection pooling (already implemented)
   - CDN for static assets

## Security Best Practices

### Current Implementation
- ✅ Environment variables for credentials
- ✅ SQL prepared statements (no injection)
- ✅ File type validation for uploads
- ✅ File size limits (10MB)
- ✅ CORS enabled for development

### Production Recommendations
- [ ] HTTPS/TLS encryption
- [ ] Input validation middleware
- [ ] Rate limiting
- [ ] Helmet.js security headers
- [ ] Database backups
- [ ] User authentication

## Development Workflow

```
1. Make code changes
2. Hot reload (Vite for frontend, nodemon for backend)
3. Test in browser at localhost:3000
4. Check database with psql
5. Commit changes
```

## Monitoring & Debugging

### Frontend
- Browser DevTools Console
- React DevTools extension
- Network tab for API calls

### Backend
- Terminal logs from Express
- PostgreSQL query logs
- `console.log()` debugging

### Database
```sql
-- View all trades
SELECT * FROM trades ORDER BY entry_time DESC LIMIT 10;

-- Check daily performance
SELECT * FROM daily_performance;

-- Database size
SELECT pg_size_pretty(pg_database_size('trading_journal'));
```

## Backup & Recovery

### Manual Backup
```bash
pg_dump trading_journal > backup.sql
```

### Restore
```bash
psql trading_journal < backup.sql
```

### Automated (Recommended)
- Set up cron job for daily backups
- Keep last 30 days
- Store in cloud (S3/Drive)

---

**This architecture provides:**
- ✅ Fast local performance
- ✅ Reliable data storage
- ✅ Easy to understand and modify
- ✅ Scalable to cloud when needed
