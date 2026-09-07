"use client";

import { useState, useEffect } from "react";
import { Lock, KeyRound, AlertCircle, Loader2, RefreshCw, CheckCircle2, Laptop, ShieldCheck, Fingerprint, Cpu } from "lucide-react";
import { cryptoWorkerBridge, wipeBuffer, base64ToUint8Array, arrayBufferToBase64 } from "@/lib/sync/crypto-worker-bridge";
import { sessionKeyStore } from "@/lib/sync/session-key-store";
import { getUserVaultProfile, updateVaultPassword } from "@/server/actions/vault-actions";
import { indexedDBManager } from "@/lib/sync/indexeddb";
import { broadcastCrossTabEvent } from "@/lib/sync/cross-tab-sync";
import { unwrapMasterKeyWithWebAuthnPrf, checkWebAuthnSupportStatus, createWebAuthnPrfEnvelope } from "@/lib/sync/webauthn-prf";
import { unwrapMasterKeyWithPin, wrapMasterKeyWithPin, generateSalt } from "@/lib/sync/encryption";
import { DeviceTrustEnvelope, DeviceTrustType, UserVaultProfile } from "@/lib/sync/types/vault";

interface VaultUnlockModalProps {
    isOpen: boolean;
    onClose: () => void;
    onUnlocked: () => void;
    userId: string;
}

export function VaultUnlockModal({ isOpen, onClose, onUnlocked, userId }: VaultUnlockModalProps) {
    const [tab, setTab] = useState<"pin" | "biometric" | "password" | "recovery">("password");
    const [pin, setPin] = useState("");
    const [deviceEnvelope, setDeviceEnvelope] = useState<DeviceTrustEnvelope | null>(null);
    const [isDeviceTrusted, setIsDeviceTrusted] = useState(false);

    const [password, setPassword] = useState("");
    const [recoverySeed, setRecoverySeed] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [confirmNewPassword, setConfirmNewPassword] = useState("");
    const [isResetStep, setIsResetStep] = useState(false);

    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [successMessage, setSuccessMessage] = useState<string | null>(null);

    // In-place Trust Device state
    const [wantTrustDevice, setWantTrustDevice] = useState(false);
    const [trustMethod, setTrustMethod] = useState<DeviceTrustType>("webauthn_prf");
    const [isHardwareSupported, setIsHardwareSupported] = useState(false);
    const [hardwareStatusMessage, setHardwareStatusMessage] = useState<string | null>(null);
    const [trustPin, setTrustPin] = useState("");
    const [trustPinConfirm, setTrustPinConfirm] = useState("");
    const [trustAgreement, setTrustAgreement] = useState(false);

    // Reset fields on modal open & check for trusted device PIN envelope
    useEffect(() => {
        if (isOpen) {
            setPassword("");
            setPin("");
            setRecoverySeed("");
            setNewPassword("");
            setConfirmNewPassword("");
            setIsResetStep(false);
            setIsLoading(false);
            setError(null);
            setSuccessMessage(null);
            setWantTrustDevice(false);
            setTrustPin("");
            setTrustPinConfirm("");
            setTrustAgreement(false);

            // Check hardware support with detailed diagnostics
            (async () => {
                try {
                    const status = await checkWebAuthnSupportStatus();
                    setIsHardwareSupported(status.supported);
                    setHardwareStatusMessage(status.message || null);
                    if (status.supported) {
                        setTrustMethod("webauthn_prf");
                    } else {
                        setTrustMethod("pin");
                    }
                } catch {
                    setIsHardwareSupported(false);
                    setHardwareStatusMessage("فشل التحقق من دعم عتاد الجهاز.");
                    setTrustMethod("pin");
                }
            })();

            // Check if device trust envelope exists
            (async () => {
                try {
                    const env = await indexedDBManager.getDeviceTrustEnvelope(userId);
                    if (env && Date.now() <= env.expiresAt && (env.failedAttempts === undefined || env.failedAttempts < 5)) {
                        setDeviceEnvelope(env);
                        setIsDeviceTrusted(true);
                        if (env.trustType === "webauthn_prf") {
                            setTab("biometric");
                        } else {
                            setTab("pin");
                        }
                    } else {
                        setDeviceEnvelope(null);
                        setIsDeviceTrusted(false);
                        setTab("password");
                    }
                } catch {
                    setDeviceEnvelope(null);
                    setIsDeviceTrusted(false);
                    setTab("password");
                }
            })();
        }
    }, [isOpen, userId]);

    if (!isOpen) return null;

    /**
     * Resolves the user vault profile:
     * Tries local IndexedDB cache first (offline-first), falls back to server if not cached.
     */
    async function resolveVaultProfile(): Promise<UserVaultProfile | null> {
        // 1. Check local IndexedDB cache
        try {
            const cached = await indexedDBManager.getCachedVaultProfile();
            if (cached) return cached;
        } catch {
            // Fall through to server
        }

        // 2. Fetch from server
        const res = await getUserVaultProfile();
        if (res.success && res.data) {
            // Cache locally for offline resilience
            try {
                await indexedDBManager.saveCachedVaultProfile(res.data as unknown as UserVaultProfile);
            } catch {
                // Ignore cache errors
            }
            return res.data as unknown as UserVaultProfile;
        }

        return null;
    }

    // Unlock via Hardware Biometrics (WebAuthn PRF)
    async function handleUnlockWithBiometrics() {
        if (!deviceEnvelope || deviceEnvelope.trustType !== "webauthn_prf") {
            setError("لا يوجد توثيق عتادي نشط لهذا الجهاز. يرجى استخدام كلمة المرور.");
            setTab("password");
            return;
        }

        setIsLoading(true);
        setError(null);

        try {
            // Check server epoch if online
            try {
                const profileRes = await getUserVaultProfile();
                if (profileRes.success && profileRes.data?.deviceTrustEpoch) {
                    if (profileRes.data.deviceTrustEpoch !== deviceEnvelope.deviceTrustEpoch) {
                        await indexedDBManager.clearDeviceTrustEnvelope(userId);
                        setDeviceEnvelope(null);
                        setIsDeviceTrusted(false);
                        setTab("password");
                        setError("تم إبطال موثوقية هذا الجهاز مركزياً. يرجى إدخال كلمة المرور الرئيسية.");
                        return;
                    }
                }
            } catch {
                // If offline, continue with local verification
            }

            const unwrappedMasterKey = await unwrapMasterKeyWithWebAuthnPrf(deviceEnvelope, userId);

            sessionKeyStore.setMasterKey(unwrappedMasterKey, 1);

            broadcastCrossTabEvent({
                type: "vault_unlocked",
            });

            setSuccessMessage("تم التحقق العتادي بنجاح!");
            setTimeout(() => {
                onUnlocked();
                onClose();
            }, 300);
        } catch (err: unknown) {
            console.error("[VaultUnlockModal] Biometric unlock error:", err);
            setError((err as Error)?.message || "فشلت المصادقة العتادية. يمكنك استخدام كلمة المرور بدلاً من ذلك.");
        } finally {
            setIsLoading(false);
        }
    }

    // Unlock via Quick 6-Digit PIN
    async function handleUnlockWithPin() {
        if (!pin || pin.length !== 6) {
            setError("يرجى إدخال رمز PIN المكون من 6 أرقام.");
            return;
        }

        if (!deviceEnvelope) {
            setError("لا يوجد توثيق نشط لهذا الجهاز. يرجى استخدام كلمة المرور.");
            setTab("password");
            return;
        }

        setIsLoading(true);
        setError(null);

        let unwrappedMasterKey: Uint8Array | null = null;
        try {
            // Check server epoch if online
            try {
                const profileRes = await getUserVaultProfile();
                if (profileRes.success && profileRes.data?.deviceTrustEpoch) {
                    if (profileRes.data.deviceTrustEpoch !== deviceEnvelope.deviceTrustEpoch) {
                        await indexedDBManager.clearDeviceTrustEnvelope(userId);
                        setDeviceEnvelope(null);
                        setIsDeviceTrusted(false);
                        setTab("password");
                        setError("تم إبطال موثوقية هذا الجهاز مركزياً. يرجى إدخال كلمة المرور الرئيسية.");
                        return;
                    }
                }
            } catch {
                // If offline, continue with local verification
            }

            unwrappedMasterKey = await unwrapMasterKeyWithPin(deviceEnvelope, pin, userId);

            // Reset failed attempts upon success
            if (deviceEnvelope.failedAttempts > 0) {
                const updatedEnv: DeviceTrustEnvelope = { ...deviceEnvelope, failedAttempts: 0 };
                await indexedDBManager.saveDeviceTrustEnvelope(updatedEnv, userId);
            }

            if (!unwrappedMasterKey) {
                throw new Error("Failed to unwrap master key");
            }

            sessionKeyStore.setMasterKey(unwrappedMasterKey, 1);

            broadcastCrossTabEvent({
                type: "vault_unlocked",
            });

            onUnlocked();
            onClose();
        } catch (err: unknown) {
            console.warn("[VaultUnlockModal] PIN unlock error:", err);
            const newAttempts = (deviceEnvelope.failedAttempts || 0) + 1;
            if (newAttempts >= 5) {
                await indexedDBManager.clearDeviceTrustEnvelope(userId);
                setDeviceEnvelope(null);
                setIsDeviceTrusted(false);
                setTab("password");
                setError("تم تجاوز الحد الأقصى للمحاولات (5). تم إلغاء موثوقية هذا الجهاز لأسباب أمنية. يرجى إدخال كلمة المرور الرئيسية.");
            } else {
                const updatedEnv: DeviceTrustEnvelope = { ...deviceEnvelope, failedAttempts: newAttempts };
                await indexedDBManager.saveDeviceTrustEnvelope(updatedEnv, userId);
                setDeviceEnvelope(updatedEnv);
                const remaining = 5 - newAttempts;
                setError(`رمز PIN غير صحيح. متبقي ${remaining} ${remaining === 1 ? 'محاولة واحدة' : 'محاولات'}.`);
            }
        } finally {
            setIsLoading(false);
        }
    }

    // Unlock via Password
    async function handleUnlockWithPassword() {
        if (!password) {
            setError("يرجى إدخال كلمة المرور.");
            return;
        }

        if (wantTrustDevice) {
            if (trustMethod === "pin") {
                if (!/^\d{6}$/.test(trustPin)) {
                    setError("يجب أن يتكون رمز الـ PIN من 6 أرقام فقط.");
                    return;
                }
                if (trustPin !== trustPinConfirm) {
                    setError("رمز الـ PIN وتأكيده غير متطابقين.");
                    return;
                }
            }
            if (!trustAgreement) {
                setError("يجب الموافقة على الإقرار الأمني قبل توثيق هذا الجهاز.");
                return;
            }
        }

        setIsLoading(true);
        setError(null);

        let passBytes: Uint8Array | null = null;
        let saltBytes: Uint8Array | null = null;
        let kekPass: Uint8Array | null = null;
        let unwrappedMasterKey: Uint8Array | null = null;

        try {
            const profile = await resolveVaultProfile();
            if (!profile) {
                setError("تعذر العثور على ملف تعريف الخزنة. تأكد من تهيئة الخزنة مسبقاً.");
                return;
            }

            saltBytes = base64ToUint8Array(profile.keySalt);
            const encoder = new TextEncoder();
            passBytes = encoder.encode(password);

            // Derive KEK-Pass
            kekPass = await cryptoWorkerBridge.deriveKeyRaw(
                passBytes,
                saltBytes,
                profile.kdfIterations || 600000,
                256
            );

            // Parse wrapped key envelope
            const wrappedObj = JSON.parse(profile.encryptedMasterKey);
            const ivBytes = base64ToUint8Array(wrappedObj.iv);

            // Unwrap Master Key
            unwrappedMasterKey = await cryptoWorkerBridge.unwrapKeyRaw(
                kekPass,
                wrappedObj.ciphertext,
                ivBytes,
                `vault:pass:${userId}`
            );

            // Deposit Master Key into volatile RAM session store
            sessionKeyStore.setMasterKey(unwrappedMasterKey, profile.keyVersion || 1);

            // In-Place Device Trust: Wrap and persist envelope if requested
            if (wantTrustDevice) {
                try {
                    const epoch = profile.deviceTrustEpoch || 1;
                    let envelope: DeviceTrustEnvelope;
                    if (trustMethod === "webauthn_prf") {
                        envelope = await createWebAuthnPrfEnvelope(
                            unwrappedMasterKey,
                            userId,
                            "user@lugx.local",
                            epoch
                        );
                    } else {
                        const deviceSalt = await generateSalt(16);
                        envelope = await wrapMasterKeyWithPin(
                            unwrappedMasterKey,
                            trustPin,
                            deviceSalt,
                            userId,
                            epoch,
                            600000
                        );
                    }
                    await indexedDBManager.saveDeviceTrustEnvelope(envelope, userId);
                    setDeviceEnvelope(envelope);
                    setIsDeviceTrusted(true);
                } catch (trustErr: unknown) {
                    console.warn("[VaultUnlockModal] Failed to wrap trust envelope during unlock:", trustErr);
                    setError((trustErr as Error)?.message || "تم فك قفل الخزنة، ولكن تعذر تفعيل توثيق هذا الجهاز.");
                    setIsLoading(false);
                    return;
                }
            }

            broadcastCrossTabEvent({
                type: "vault_unlocked",
            });

            onUnlocked();
            onClose();
        } catch (err: unknown) {
            console.error("[VaultUnlockModal] Password unlock failure:", err);
            setError("كلمة المرور غير صحيحة. يرجى إعادة المحاولة.");
        } finally {
            if (passBytes) wipeBuffer(passBytes);
            if (saltBytes) wipeBuffer(saltBytes);
            if (kekPass) wipeBuffer(kekPass);
            setIsLoading(false);
        }
    }

    // Unlock & Reset via 12-Word Recovery Seed
    async function handleUnlockWithSeed() {
        const cleanedSeed = recoverySeed.trim().toLowerCase();
        const wordCount = cleanedSeed.split(/\s+/).length;

        if (wordCount !== 12) {
            setError("يجب أن تتكون بذرة الاسترجاع من 12 كلمة بالضبط.");
            return;
        }

        setIsLoading(true);
        setError(null);

        try {
            // Validate mnemonic checksum
            const validation = await cryptoWorkerBridge.validateMnemonic(cleanedSeed);
            if (!validation.isValid) {
                setError("بذرة الاسترجاع غير صالحة. تأكد من ترتيب الكلمات وهجائها.");
                return;
            }

            const profile = await resolveVaultProfile();
            if (!profile) {
                setError("تعذر العثور على ملف تعريف الخزنة.");
                return;
            }

            const recoverySaltBytes = base64ToUint8Array(profile.recoverySalt);

            // Derive KEK-Seed
            const kekSeed = await cryptoWorkerBridge.mnemonicToSeed(
                cleanedSeed,
                recoverySaltBytes,
                profile.kdfIterations || 600000
            );

            const wrappedObj = JSON.parse(profile.recoveryEncryptedMasterKey);
            const ivBytes = base64ToUint8Array(wrappedObj.iv);

            // Unwrap Master Key
            const unwrappedMasterKey = await cryptoWorkerBridge.unwrapKeyRaw(
                kekSeed,
                wrappedObj.ciphertext,
                ivBytes,
                `vault:recovery:${userId}`
            );

            wipeBuffer(kekSeed);
            wipeBuffer(recoverySaltBytes);

            // Temporarily store in memory to allow setting a new password
            sessionKeyStore.setMasterKey(unwrappedMasterKey, profile.keyVersion || 1);

            setIsResetStep(true);
            setSuccessMessage("تم التحقق من بذرة الاسترجاع بنجاح. يرجى تعيين كلمة مرور جديدة للخزنة.");
        } catch (err: unknown) {
            console.error("[VaultUnlockModal] Recovery seed unlock failure:", err);
            setError("بذرة الاسترجاع غير صحيحة أو تالفة. يرجى التأكد من الكلمات.");
        } finally {
            setIsLoading(false);
        }
    }

    // Complete Password Reset
    async function handleCompletePasswordReset() {
        if (!newPassword || newPassword.length < 8) {
            setError("يجب ألا تقل كلمة المرور الجديدة عن 8 أحرف.");
            return;
        }

        if (newPassword !== confirmNewPassword) {
            setError("كلمتا المرور غير متطابقتين.");
            return;
        }

        setIsLoading(true);
        setError(null);

        let newSaltBytes: Uint8Array | null = null;
        let passBytes: Uint8Array | null = null;
        let kekPass: Uint8Array | null = null;
        let ivPass: Uint8Array | null = null;

        try {
            const masterKey = sessionKeyStore.getMasterKeyRaw();
            if (!masterKey) {
                setError("انتهت صلاحية الجلسة أثناء إعادة التعيين. يرجى البدء مجدداً.");
                setIsResetStep(false);
                return;
            }

            newSaltBytes = await cryptoWorkerBridge.generateRandomBytes(16);
            const encoder = new TextEncoder();
            passBytes = encoder.encode(newPassword);

            kekPass = await cryptoWorkerBridge.deriveKeyRaw(
                passBytes,
                newSaltBytes,
                600000,
                256
            );

            ivPass = await cryptoWorkerBridge.generateRandomBytes(12);
            const wrappedPassword = await cryptoWorkerBridge.wrapKeyRaw(
                kekPass,
                masterKey,
                ivPass,
                `vault:pass:${userId}`
            );

            const payload = {
                encryptedMasterKey: JSON.stringify({
                    ciphertext: wrappedPassword.wrappedKeyBase64,
                    iv: wrappedPassword.ivBase64,
                }),
                keySalt: arrayBufferToBase64(newSaltBytes),
                kdfIterations: 600000,
            };

            // Update local IDB cache
            try {
                const currentProfile = await resolveVaultProfile();
                if (currentProfile) {
                    await indexedDBManager.saveCachedVaultProfile({
                        ...currentProfile,
                        ...payload,
                        updatedAt: new Date(),
                    });
                }
            } catch (idbErr) {
                console.warn("[VaultUnlockModal] Local IDB cache update deferred:", idbErr);
            }

            // Sync with Supabase
            try {
                const serverRes = await updateVaultPassword(payload);
                if (!serverRes.success) {
                    console.warn("[VaultUnlockModal] Cloud password update deferred:", serverRes.error);
                }
            } catch (serverErr) {
                console.warn("[VaultUnlockModal] Cloud password update deferred:", serverErr);
            }

            broadcastCrossTabEvent({
                type: "vault_unlocked",
            });

            onUnlocked();
            onClose();
        } catch (err: unknown) {
            console.error("[VaultUnlockModal] Password reset error:", err);
            setError("فشل تحديث كلمة المرور: " + ((err as Error)?.message || "خطأ غير متوقع"));
        } finally {
            if (newSaltBytes) wipeBuffer(newSaltBytes);
            if (passBytes) wipeBuffer(passBytes);
            if (kekPass) wipeBuffer(kekPass);
            if (ivPass) wipeBuffer(ivPass);
            setIsLoading(false);
        }
    }

    return (
        <>
            {/* Backdrop */}
            <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 transition-opacity" onClick={onClose} />

            {/* Modal Dialog */}
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl w-full max-w-md overflow-hidden text-right" dir="rtl">
                    {/* Header */}
                    <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between">
                        <div className="flex items-center gap-2.5">
                            <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                                <Lock className="w-5 h-5" />
                            </div>
                            <div>
                                <h3 className="text-base font-semibold text-zinc-100">فتح قفل الخزنة المشفرة</h3>
                                <p className="text-xs text-zinc-400">مطلوب لفك تشفير وتعديل المستندات المحمية</p>
                            </div>
                        </div>

                        {isDeviceTrusted && !isResetStep && (
                            <span className="text-[11px] px-2 py-0.5 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 flex items-center gap-1">
                                <Laptop className="w-3 h-3" />
                                <span>جهاز موثوق</span>
                            </span>
                        )}
                    </div>

                    {/* Tabs */}
                    {!isResetStep && (
                        <div className="flex border-b border-zinc-800 bg-zinc-950/40 text-xs font-medium">
                            {isDeviceTrusted && deviceEnvelope?.trustType === "webauthn_prf" && (
                                <button
                                    onClick={() => {
                                        setTab("biometric");
                                        setError(null);
                                    }}
                                    className={`flex-1 py-2.5 text-center transition-colors cursor-pointer flex items-center justify-center gap-1.5 ${
                                        tab === "biometric"
                                            ? "text-indigo-400 border-b-2 border-indigo-500 bg-zinc-900"
                                            : "text-zinc-500 hover:text-zinc-300"
                                    }`}
                                >
                                    <Fingerprint className="w-3.5 h-3.5" />
                                    <span>المصادقة العتادية</span>
                                </button>
                            )}
                            {isDeviceTrusted && deviceEnvelope?.trustType !== "webauthn_prf" && (
                                <button
                                    onClick={() => {
                                        setTab("pin");
                                        setError(null);
                                    }}
                                    className={`flex-1 py-2.5 text-center transition-colors cursor-pointer flex items-center justify-center gap-1.5 ${
                                        tab === "pin"
                                            ? "text-indigo-400 border-b-2 border-indigo-500 bg-zinc-900"
                                            : "text-zinc-500 hover:text-zinc-300"
                                    }`}
                                >
                                    <Laptop className="w-3.5 h-3.5" />
                                    <span>رمز PIN السريع</span>
                                </button>
                            )}
                            <button
                                onClick={() => {
                                    setTab("password");
                                    setError(null);
                                }}
                                className={`flex-1 py-2.5 text-center transition-colors cursor-pointer flex items-center justify-center gap-1.5 ${
                                    tab === "password"
                                        ? "text-indigo-400 border-b-2 border-indigo-500 bg-zinc-900"
                                        : "text-zinc-500 hover:text-zinc-300"
                                }`}
                            >
                                <KeyRound className="w-3.5 h-3.5" />
                                <span>كلمة المرور</span>
                            </button>
                            <button
                                onClick={() => {
                                    setTab("recovery");
                                    setError(null);
                                }}
                                className={`flex-1 py-2.5 text-center transition-colors cursor-pointer flex items-center justify-center gap-1.5 ${
                                    tab === "recovery"
                                        ? "text-indigo-400 border-b-2 border-indigo-500 bg-zinc-900"
                                        : "text-zinc-500 hover:text-zinc-300"
                                }`}
                            >
                                <RefreshCw className="w-3.5 h-3.5" />
                                <span>استرجاع بالبذرة (12 كلمة)</span>
                            </button>
                        </div>
                    )}

                    {/* Body */}
                    <div className="p-6 space-y-4">
                        {error && (
                            <div className="p-3 rounded-lg bg-red-950/40 border border-red-800/40 text-red-300 text-xs flex items-center gap-2">
                                <AlertCircle className="w-4 h-4 shrink-0" />
                                <span>{error}</span>
                            </div>
                        )}

                        {successMessage && (
                            <div className="p-3 rounded-lg bg-green-950/40 border border-green-800/40 text-green-300 text-xs flex items-center gap-2">
                                <CheckCircle2 className="w-4 h-4 shrink-0" />
                                <span>{successMessage}</span>
                            </div>
                        )}

                        {/* TAB 0-A: Hardware Biometric Unlock */}
                        {!isResetStep && tab === "biometric" && isDeviceTrusted && (
                            <div className="space-y-4 text-center py-2 animate-in fade-in duration-150">
                                <div className="mx-auto w-16 h-16 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 flex items-center justify-center">
                                    <Fingerprint className="w-8 h-8" />
                                </div>
                                <div>
                                    <h4 className="text-sm font-semibold text-zinc-100 mb-1">
                                        فتح الخزنة بالمصادقة العتادية
                                    </h4>
                                    <p className="text-xs text-zinc-400 max-w-xs mx-auto">
                                        انقر أدناه لتأكيد هويتك عبر Windows Hello أو البصمة أو مستشعر الجهاز.
                                    </p>
                                </div>

                                <button
                                    type="button"
                                    onClick={handleUnlockWithBiometrics}
                                    disabled={isLoading}
                                    className="w-full py-3 px-4 rounded-xl font-medium text-sm text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/20 cursor-pointer"
                                >
                                    {isLoading ? (
                                        <>
                                            <Loader2 className="w-4 h-4 animate-spin" />
                                            <span>جاري التحقق العتادي...</span>
                                        </>
                                    ) : (
                                        <>
                                            <Fingerprint className="w-4 h-4" />
                                            <span>فتح عبر البصمة / Windows Hello</span>
                                        </>
                                    )}
                                </button>

                                <div className="pt-2 text-[11px] text-zinc-400 flex items-center justify-between">
                                    <span className="flex items-center gap-1 text-emerald-400 font-mono text-[10px]">
                                        <Cpu className="w-3 h-3" />
                                        TPM / Secure Enclave
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => setTab("password")}
                                        className="text-indigo-400 hover:underline cursor-pointer"
                                    >
                                        استخدام كلمة المرور بدلاً من ذلك
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* TAB 0-B: PIN Unlock */}
                        {!isResetStep && tab === "pin" && isDeviceTrusted && (
                            <div className="space-y-3 animate-in fade-in duration-150">
                                <div>
                                    <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                                        رمز PIN لهذا الجهاز الموثوق (6 أرقام)
                                    </label>
                                    <input
                                        type="password"
                                        maxLength={6}
                                        inputMode="numeric"
                                        pattern="[0-9]*"
                                        value={pin}
                                        onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                                        placeholder="••••••"
                                        className="w-full px-4 py-3 bg-zinc-800/80 border border-zinc-700 rounded-lg text-xl tracking-widest text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 text-center font-mono"
                                        dir="ltr"
                                        autoFocus
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter" && pin.length === 6) handleUnlockWithPin();
                                        }}
                                    />
                                </div>
                                <div className="flex items-center justify-between text-[11px] text-zinc-400">
                                    <span>يفتح الخزنة محلياً لهذا الجهاز</span>
                                    <button
                                        type="button"
                                        onClick={() => setTab("password")}
                                        className="text-indigo-400 hover:underline cursor-pointer"
                                    >
                                        استخدام كلمة المرور بدلاً من ذلك
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* TAB 1: Password Unlock */}
                        {!isResetStep && tab === "password" && (
                            <div className="space-y-3">
                                <div>
                                    <label className="block text-xs font-medium text-zinc-300 mb-1.5">كلمة مرور الخزنة</label>
                                    <input
                                        type="password"
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        placeholder="أدخل كلمة المرور..."
                                        className="w-full px-3 py-2 bg-zinc-800/80 border border-zinc-700 rounded-lg text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 text-left font-mono"
                                        dir="ltr"
                                        autoFocus
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter") handleUnlockWithPassword();
                                        }}
                                    />
                                </div>
                                <div className="pt-2 border-t border-zinc-800/60 space-y-3">
                                    <label className="flex items-center gap-2 cursor-pointer select-none">
                                        <input
                                            type="checkbox"
                                            checked={wantTrustDevice}
                                            onChange={(e) => setWantTrustDevice(e.target.checked)}
                                            className="w-4 h-4 rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                                        />
                                        <span className="text-xs font-medium text-zinc-200 flex items-center gap-1.5">
                                            <ShieldCheck className="w-3.5 h-3.5 text-indigo-400" />
                                            <span>
                                                {isDeviceTrusted
                                                    ? `تحديث إعدادات موثوقية هذا الجهاز (${deviceEnvelope?.trustType === "webauthn_prf" ? "المصادقة العتادية" : "رمز PIN"})`
                                                    : "الوثوق بهذا الجهاز (تفعيل الفتح السريع لمدة 30 يوماً)"}
                                            </span>
                                        </span>
                                    </label>

                                        {wantTrustDevice && (
                                            <div className="p-3.5 bg-zinc-950/60 border border-indigo-500/30 rounded-xl space-y-3 animate-in fade-in">
                                                {/* Dual Sub-Option Selector */}
                                                <div className="grid grid-cols-2 gap-2">
                                                    {/* Hardware Biometrics Card */}
                                                    <button
                                                        type="button"
                                                        onClick={() => isHardwareSupported && setTrustMethod("webauthn_prf")}
                                                        disabled={!isHardwareSupported}
                                                        className={`p-2.5 rounded-lg border text-right transition-all flex flex-col justify-between ${
                                                            trustMethod === "webauthn_prf"
                                                                ? "bg-indigo-950/40 border-indigo-500 shadow-sm shadow-indigo-500/20"
                                                                : isHardwareSupported
                                                                ? "bg-zinc-900 border-zinc-800 hover:border-zinc-700"
                                                                : "bg-zinc-950/40 border-zinc-900 opacity-50 cursor-not-allowed"
                                                        }`}
                                                    >
                                                        <div className="flex items-center justify-between w-full mb-1">
                                                            <Fingerprint className={`w-4 h-4 ${trustMethod === "webauthn_prf" ? "text-indigo-400" : "text-zinc-400"}`} />
                                                            <span className="text-[9px] px-1.5 py-0.2 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
                                                                TPM / Enclave
                                                            </span>
                                                        </div>
                                                        <div className="text-[11px] font-semibold text-zinc-200">
                                                            المصادقة العتادية
                                                        </div>
                                                        <div className="text-[10px] text-zinc-400">
                                                            {isHardwareSupported ? "Windows Hello / البصمة" : (hardwareStatusMessage || "غير مدعوم هنا")}
                                                        </div>
                                                    </button>

                                                    {/* 6-Digit PIN Card */}
                                                    <button
                                                        type="button"
                                                        onClick={() => setTrustMethod("pin")}
                                                        className={`p-2.5 rounded-lg border text-right transition-all flex flex-col justify-between ${
                                                            trustMethod === "pin"
                                                                ? "bg-indigo-950/40 border-indigo-500 shadow-sm shadow-indigo-500/20"
                                                                : "bg-zinc-900 border-zinc-800 hover:border-zinc-700"
                                                        }`}
                                                    >
                                                        <div className="flex items-center justify-between w-full mb-1">
                                                            <KeyRound className={`w-4 h-4 ${trustMethod === "pin" ? "text-indigo-400" : "text-zinc-400"}`} />
                                                            <span className="text-[9px] px-1.5 py-0.2 rounded bg-zinc-800 text-zinc-400 border border-zinc-700 font-mono">
                                                                PIN
                                                            </span>
                                                        </div>
                                                        <div className="text-[11px] font-semibold text-zinc-200">
                                                            رمز PIN (6 أرقام)
                                                        </div>
                                                        <div className="text-[10px] text-zinc-400">
                                                            حماية برمجية
                                                        </div>
                                                    </button>
                                                </div>

                                                {/* PIN Inputs (Only if PIN selected) */}
                                                {trustMethod === "pin" && (
                                                    <div className="grid grid-cols-2 gap-2 animate-in fade-in">
                                                        <div>
                                                            <label className="block text-[11px] text-zinc-400 mb-1">رمز PIN (6 أرقام)</label>
                                                            <input
                                                                type="password"
                                                                maxLength={6}
                                                                inputMode="numeric"
                                                                value={trustPin}
                                                                onChange={(e) => setTrustPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                                                                placeholder="••••••"
                                                                className="w-full px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-center font-mono tracking-widest text-zinc-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                                                                dir="ltr"
                                                            />
                                                        </div>
                                                        <div>
                                                            <label className="block text-[11px] text-zinc-400 mb-1">تأكيد رمز PIN</label>
                                                            <input
                                                                type="password"
                                                                maxLength={6}
                                                                inputMode="numeric"
                                                                value={trustPinConfirm}
                                                                onChange={(e) => setTrustPinConfirm(e.target.value.replace(/\D/g, "").slice(0, 6))}
                                                                placeholder="••••••"
                                                                className="w-full px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-center font-mono tracking-widest text-zinc-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                                                                dir="ltr"
                                                            />
                                                        </div>
                                                    </div>
                                                )}

                                                {/* Security Disclaimer Note */}
                                                <div className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300 text-[11px] leading-relaxed">
                                                    {trustMethod === "webauthn_prf" ? (
                                                        <span>
                                                            سيتم ربط المفتاح بشريحة الأمان العتادية عبر Windows Hello أو البصمة، مع مناعة كاملة ضد استخراج قاعدة البيانات.
                                                        </span>
                                                    ) : (
                                                        <span>
                                                            سيتم تشفير المفتاح برمز الـ PIN محلياً. تقع مسؤولية تأمين العتاد المادي بالكامل على عاتقك (تخضع لـ TD-10).
                                                        </span>
                                                    )}
                                                </div>

                                                {/* Agreement Checkbox */}
                                                <label className="flex items-start gap-2 cursor-pointer select-none text-[11px] text-zinc-400">
                                                    <input
                                                        type="checkbox"
                                                        checked={trustAgreement}
                                                        onChange={(e) => setTrustAgreement(e.target.checked)}
                                                        className="mt-0.5 w-3.5 h-3.5 rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-indigo-500"
                                                    />
                                                    <span>
                                                        {trustMethod === "webauthn_prf"
                                                            ? "أقر بأن هذا جهازي الشخصي، وأوافق على تفعيل المصادقة العتادية."
                                                            : "أقر بأن هذا جهازي الشخصي، وأفوض حفظ مغلف مشفر محلياً برمز الـ PIN."}
                                                    </span>
                                                </label>
                                            </div>
                                        )}
                                    </div>
                                </div>
                        )}

                        {/* TAB 2: Recovery Seed Unlock */}
                        {!isResetStep && tab === "recovery" && (
                            <div>
                                <label className="block text-xs font-medium text-zinc-300 mb-1.5">بذرة الاسترجاع (الـ 12 كلمة)</label>
                                <textarea
                                    value={recoverySeed}
                                    onChange={(e) => setRecoverySeed(e.target.value)}
                                    placeholder="word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12"
                                    rows={3}
                                    className="w-full px-3 py-2 bg-zinc-800/80 border border-zinc-700 rounded-lg text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 text-left font-mono"
                                    dir="ltr"
                                />
                                <p className="text-[11px] text-zinc-500 mt-1">افصل بين الكلمات بمسافة واحدة.</p>
                            </div>
                        )}

                        {/* RESET STEP: Set New Password */}
                        {isResetStep && (
                            <div className="space-y-3">
                                <div>
                                    <label className="block text-xs font-medium text-zinc-300 mb-1.5">كلمة المرور الجديدة</label>
                                    <input
                                        type="password"
                                        value={newPassword}
                                        onChange={(e) => setNewPassword(e.target.value)}
                                        placeholder="••••••••••••"
                                        className="w-full px-3 py-2 bg-zinc-800/80 border border-zinc-700 rounded-lg text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 text-left"
                                        dir="ltr"
                                        autoFocus
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-zinc-300 mb-1.5">تأكيد كلمة المرور الجديدة</label>
                                    <input
                                        type="password"
                                        value={confirmNewPassword}
                                        onChange={(e) => setConfirmNewPassword(e.target.value)}
                                        placeholder="••••••••••••"
                                        className="w-full px-3 py-2 bg-zinc-800/80 border border-zinc-700 rounded-lg text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 text-left"
                                        dir="ltr"
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter") handleCompletePasswordReset();
                                        }}
                                    />
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Footer */}
                    <div className="px-6 py-3 border-t border-zinc-800 flex items-center justify-between">
                        <button
                            onClick={onClose}
                            disabled={isLoading}
                            className="px-4 py-2 text-xs text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
                        >
                            إلغاء
                        </button>

                        {!isResetStep && tab === "pin" && isDeviceTrusted && (
                            <button
                                onClick={handleUnlockWithPin}
                                disabled={isLoading || pin.length !== 6}
                                className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                            >
                                {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Laptop className="w-3.5 h-3.5" />}
                                <span>تأكيد الـ PIN</span>
                            </button>
                        )}

                        {!isResetStep && tab === "password" && (
                            <button
                                onClick={handleUnlockWithPassword}
                                disabled={isLoading}
                                className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer"
                            >
                                {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Lock className="w-3.5 h-3.5" />}
                                <span>فتح القفل</span>
                            </button>
                        )}

                        {!isResetStep && tab === "recovery" && (
                            <button
                                onClick={handleUnlockWithSeed}
                                disabled={isLoading}
                                className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer"
                            >
                                {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                                <span>التحقق والاسترجاع</span>
                            </button>
                        )}

                        {isResetStep && (
                            <button
                                onClick={handleCompletePasswordReset}
                                disabled={isLoading}
                                className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer"
                            >
                                {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                                <span>حفظ وتفعيل</span>
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </>
    );
}
