ALTER TABLE indexer_cursors
  ADD COLUMN coverage_start_height INTEGER NOT NULL DEFAULT 0;

ALTER TABLE indexer_cursors
  ADD COLUMN finalized_head_height INTEGER NOT NULL DEFAULT 0;

ALTER TABLE indexer_cursors
  ADD COLUMN history_complete INTEGER NOT NULL DEFAULT 0 CHECK (history_complete IN (0, 1));
