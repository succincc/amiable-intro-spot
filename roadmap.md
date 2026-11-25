# Gmail Settings
- [x] Confirm c2ca97a is present.
- [x] Apply the three requested migrations in order and regenerate types.
- [x] Verify owner-only policies and supply missing access grants.
- [x] Add Gmail connection controls and one-time OAuth result banners; retain Apps Script fallback.
- [x] Run tests and signed-in Settings checks; commit changes.

# Receipt confirmation migration
- [x] Confirm main contains commit 49d0e78.
- [x] Apply the provided receipt migration with its Drizzle mirror and verify the back-fill count (1 job; 0 eligible rows remain).
- [x] Run regression tests and security checks; save generated files.
- [x] Request publishing of the snapshot containing 49d0e78 and the Drizzle mirror.

# Daily summary, availability, and heartbeat
- [x] Confirm synced main includes 489994e or newer.
- [x] Apply the three requested migrations in order and verify the schema and timer (both extensions available; five-minute timer active).
- [x] Run all tests and publishing security checks (63 tests passed; build OK; basic scan found no issues).
- [x] Commit generated migration files and request publishing.

# Remove database timer
- [x] Confirm synced main includes 15f2c8b.
- [x] Apply the supplied timer-removal migration and confirm applypilot-tick is absent (0 matching jobs).
- [x] Run tests and basic publishing security checks (63 tests passed; build OK; basic scan found no issues).
- [x] Save generated files and request publishing.