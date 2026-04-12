## What this PR does

## Type of change
- [ ] Bug fix
- [ ] New connector
- [ ] New feature
- [ ] Documentation

## Testing done
- [ ] `cd client && bun run build` passes with zero errors
- [ ] Server starts without errors
- [ ] Feature/fix works as described

## Connector checklist (if applicable)
- [ ] Implements full connector interface (id, name, category, authType, capabilities, signalTypes, healthCheck, fetch, extractMetrics)
- [ ] Signal rules added to `server/signals/rules.js`
- [ ] CONNECTOR_TABS entry added to `ConnectorDataPage.jsx`
- [ ] Sidebar icon added to `Sidebar.jsx`
- [ ] `.env.example` updated if new env vars required
