CREATE TABLE IF NOT EXISTS private_vcs (
    channel_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_private_vcs_owner_id ON private_vcs(owner_id);
CREATE INDEX IF NOT EXISTS idx_private_vcs_guild_id ON private_vcs(guild_id);
