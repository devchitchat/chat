export function run(db) {
  try { db.exec(`ALTER TABLE deliveries ADD COLUMN mention_priority TEXT NOT NULL DEFAULT 'normal'`) } catch { /* already exists */ }
}
