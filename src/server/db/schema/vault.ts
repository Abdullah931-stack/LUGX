import { pgTable, uuid, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users";

// User Vault Profiles table - zero-knowledge encrypted master key profiles (dual-tier wrapping)
export const userVaultProfiles = pgTable("user_vault_profiles", {
    userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
    encryptedMasterKey: text("encrypted_master_key").notNull(),
    recoveryEncryptedMasterKey: text("recovery_encrypted_master_key").notNull(),
    keySalt: text("key_salt").notNull(),
    recoverySalt: text("recovery_salt").notNull(),
    kdfIterations: integer("kdf_iterations").default(600000).notNull(),
    keyVersion: integer("key_version").default(1).notNull(),
    deviceTrustEpoch: integer("device_trust_epoch").default(1).notNull(),
    allowAIOnEncryptedFiles: boolean("allow_ai_on_encrypted_files").default(false).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type UserVaultProfile = typeof userVaultProfiles.$inferSelect;
export type NewUserVaultProfile = typeof userVaultProfiles.$inferInsert;
