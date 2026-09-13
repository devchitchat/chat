/**
 * Rename hub visibility value 'restricted' → 'private' to match channel naming.
 */
export function run(db) {
  db.exec(`UPDATE hubs SET visibility = 'private' WHERE visibility = 'restricted'`)
}
