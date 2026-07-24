---
name: create-migration
description: "Create a new Drizzle database migration. Use when adding tables, columns, indexes, or changing schema. Triggers for 'create migration', 'add column', 'new table', 'schema change', 'db migration', or 'alter table'."
visibility: public
allowed-tools: Bash, Read, Write, Glob
argument-hint: "<description>"
disable-model-invocation: true
---

# Create Database Migration

You are creating a new Drizzle ORM migration for the orchestrator project.

## Migration Location

- **SQL files**: `packages/orchestrator/drizzle/NNNN_description.sql`
- **Schema files**: `packages/orchestrator/src/db/schema/*.ts`
- **Config**: `packages/orchestrator/drizzle.config.ts`

## Steps

### 1. Determine next migration number

```bash
ls packages/orchestrator/drizzle/*.sql | tail -1
```

Increment the number by 1 (e.g., 0044 → 0045). Zero-pad to 4 digits.

### 2. Create the SQL migration file

Write the file at `packages/orchestrator/drizzle/NNNN_description.sql`:

```sql
-- Example: Adding a column
ALTER TABLE "projects" ADD COLUMN "archived" boolean DEFAULT false;

-- Example: Creating a table
CREATE TABLE IF NOT EXISTS "table_name" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

-- Example: Adding an index
CREATE INDEX IF NOT EXISTS "idx_name" ON "table_name" ("column_name");
```

### 3. Update the Drizzle schema

Edit the corresponding schema file in `packages/orchestrator/src/db/schema/`:

```typescript
// Add the column to the table definition
export const projects = pgTable('projects', {
  // ... existing columns
  archived: boolean('archived').default(false),
});
```

### 4. Run the migration

```bash
cd packages/orchestrator && npm run db:migrate
```

### 5. Verify

```bash
./scripts/dev-build.sh check orchestrator
```

## Safety Rules

- Always use `IF NOT EXISTS` / `IF EXISTS` for idempotency
- Add `DEFAULT` values when adding NOT NULL columns to existing tables
- Never drop columns without confirming data loss is acceptable
- Use `ALTER TABLE ... ADD COLUMN` (not recreate) for simple additions
- Test migration on a fresh DB: `npm run db:migrate` from clean state

## Naming Convention

- File: `NNNN_short_snake_case_description.sql` (e.g., `0045_add_archived_flag.sql`)
- Use descriptive names that explain WHAT changed, not WHY
