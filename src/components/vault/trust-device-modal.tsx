"use client";

import { useState, useEffect } from "react";
import { ShieldCheck, Lock, AlertTriangle, Loader2, CheckCircle2, X, Fingerprint, KeyRound, Cpu } from "lucide-react";
import { sessionKeyStore } from "@/lib/sync/session-key-store";
import { indexedDBManager } from "@/lib/sync/indexeddb";
import { wrapMasterKeyWithPin, generateSalt } from "@/lib/sync/encryption";
import { checkWebAuthnSupportStatus, createWebAuthnPrfEnvelope } from "@/lib/sync/webauthn-prf";
import { getUserVaultProfile } from "@/server/actions/vault-actions";
import { cryptoWorkerBridge, wipeBuffer, base64ToUint8Array } from "@/lib/sync/crypto-worker-bridge";
import type { DeviceTrustType } from "@/lib/sync/types/vault";

interface TrustDeviceModalProps {
    isOpen: boolean;
    onClose: () => void;
    userId: string;
    userEmail?: string;
    onSuccess?: () => void;
}

export function TrustDeviceModal({ isOpen, onClose, userId, userEmail, onSuccess }: TrustDeviceModalProps) {
    const [trustMethod, setTrustMethod] = useState<DeviceTrustType>("webauthn_prf");
    const [isHardwareSupported, setIsHardwareSupported] = useState<boolean>(false);
    const [hardwareStatusMessage, setHardwareStatusMessage] = useState<string | null>(null);
    const [password, setPassword] = useState("");
    const [pin, setPin] = useState("");
    const [confirmPin, setConfirmPin] = useState("");
    const [agreementChecked, setAgreementChecked] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState(false);

    useEffect(() => {
        if (isOpen) {
            setPassword("");
            setPin("");
            setConfirmPin("");
            setAgreementChecked(false);
            setIsLoading(false);
            setError(null);
            setSuccess(false);

            // Check hardware support with diagnostic messaging
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
        }
    }, [isOpen]);

    if (!isOpen) return null;

    async function ensureMasterKey(): Promise<Uint8Array | null> {
        let masterKeyRaw = sessionKeyStore.getMasterKeyRaw();
        if (masterKeyRaw) return masterKeyRaw;

        if (!password) {
            setError("يرجى إدخال كلمة مرور الخزنة الرئيسية لتأكيد التوثيق.");
            return null;
        }

        const profileRes = await getUserVaultProfile();
        if (!profileRes.success || !profileRes.data) {
            setError("تعذر العثور على ملف تعريف الخزنة.");
            return null;
        }
        const profile = profileRes.data;

        const passBytes = new TextEncoder().encode(password);
        const saltBytes = base64ToUint8Array(profile.keySalt);
        let kekPass: Uint8Array | null = null;
        try {
            kekPass = await cryptoWorkerBridge.deriveKeyRaw(
                passBytes,
                saltBytes,
                profile.kdfIterations || 600000,
                256
            );

            const wrappedObj = JSON.parse(profile.encryptedMasterKey);
            const ivBytes = base64ToUint8Array(wrappedObj.iv);

            masterKeyRaw = await cryptoWorkerBridge.unwrapKeyRaw(
                kekPass,
                wrappedObj.ciphertext,
                ivBytes,
                `vault:pass:${userId}`
            );
            sessionKeyStore.setMasterKey(masterKeyRaw, profile.keyVersion || 1);
            return masterKeyRaw;
        } catch {
            setError("كلمة مرور الخزنة غير صحيحة.");
            return null;
        } finally {
            wipeBuffer(passBytes);
            wipeBuffer(saltBytes);
            if (kekPass) wipeBuffer(kekPass);
        }
    }

    async function handleSaveDeviceTrust() {
        setError(null);

        if (!agreementChecked) {
            setError("يجب الموافقة على الإقرار الأمني قبل تفعيل موثوقية الجهاز.");
            return;
        }

        if (trustMethod === "pin") {
            if (!/^\d{6}$/.test(pin)) {
                setError("يجب أن يتكون رمز الـ PIN من 6 أرقام فقط (0-9).");
                return;
            }

            if (pin !== confirmPin) {
                setError("رمز الـ PIN وتأكيده غير متطابقين.");
                return;
            }
        }

        setIsLoading(true);
        try {
            const masterKeyRaw = await ensureMasterKey();
            if (!masterKeyRaw) {
                setIsLoading(false);
                return;
            }

            const profileRes = await getUserVaultProfile();
            const epoch = (profileRes.success && profileRes.data?.deviceTrustEpoch) || 1;

            if (trustMethod === "webauthn_prf") {
                // Hardware-bound WebAuthn PRF
                const envelope = await createWebAuthnPrfEnvelope(
                    masterKeyRaw,
                    userId,
                    userEmail || "user@lugx.local",
                    epoch
                );
                await indexedDBManager.saveDeviceTrustEnvelope(envelope, userId);
            } else {
                // Software-bound 6-digit PIN
                const deviceSalt = await generateSalt(16);
                const envelope = await wrapMasterKeyWithPin(
                    masterKeyRaw,
                    pin,
                    deviceSalt,
                    userId,
                    epoch,
                    600000
                );
                await indexedDBManager.saveDeviceTrustEnvelope(envelope, userId);
            }

            setSuccess(true);
            setTimeout(() => {
                onSuccess?.();
                onClose();
            }, 1200);
        } catch (err: unknown) {
            console.error("[TrustDeviceModal] Failed to wrap and save trust envelope:", err);
            setError((err as Error)?.message || "فشل حفظ إعدادات توثيق الجهاز. يرجى المحاولة مجدداً.");
        } finally {
            setIsLoading(false);
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="relative w-full max-w-lg p-6 overflow-hidden rounded-2xl bg-zinc-950 border border-zinc-800 shadow-2xl">
                {/* Close Button */}
                <button
                    onClick={onClose}
                    disabled={isLoading}
                    className="absolute top-4 left-4 p-2 text-zinc-400 hover:text-zinc-200 transition-colors rounded-lg hover:bg-zinc-900"
                    title="إغلاق"
                >
                    <X className="w-5 h-5" />
                </button>

                {/* Header */}
                <div className="flex flex-col items-center text-center mb-6">
                    <div className="p-3 mb-3 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">
                        <ShieldCheck className="w-8 h-8" />
                    </div>
                    <h2 className="text-xl font-bold text-zinc-100">الوثوق بهذا الجهاز (Trusted Device)</h2>
                    <p className="text-sm text-zinc-400 mt-1">
                        اختر وسيلة التوثيق لتسهيل فتح الخزنة محلياً على هذا الجهاز لمدة 30 يوماً
                    </p>
                </div>

                {success ? (
                    <div className="p-6 text-center space-y-3">
                        <div className="inline-flex p-3 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                            <CheckCircle2 className="w-10 h-10" />
                        </div>
                        <h3 className="text-lg font-semibold text-zinc-100">تم توثيق الجهاز بنجاح!</h3>
                        <p className="text-sm text-zinc-400">
                            {trustMethod === "webauthn_prf"
                                ? "يمكنك الآن فتح الخزنة بلمسة البصمة / Windows Hello فورياً."
                                : "يمكنك الآن فتح الخزنة برمز الـ PIN السريع عند كل زيارة."}
                        </p>
                    </div>
                ) : (
                    <div className="space-y-4">
                        {/* Sub-option Selection Cards */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {/* Card 1: Hardware Biometrics */}
                            <button
                                type="button"
                                onClick={() => isHardwareSupported && setTrustMethod("webauthn_prf")}
                                disabled={!isHardwareSupported}
                                className={`p-3.5 rounded-xl border text-right transition-all flex flex-col justify-between ${
                                    trustMethod === "webauthn_prf"
                                        ? "bg-indigo-950/40 border-indigo-500 shadow-sm shadow-indigo-500/20"
                                        : isHardwareSupported
                                        ? "bg-zinc-900/60 border-zinc-800 hover:border-zinc-700"
                                        : "bg-zinc-950/40 border-zinc-900 opacity-50 cursor-not-allowed"
                                }`}
                            >
                                <div className="flex items-center justify-between w-full mb-2">
                                    <div className={`p-2 rounded-lg ${trustMethod === "webauthn_prf" ? "bg-indigo-500/20 text-indigo-400" : "bg-zinc-800 text-zinc-400"}`}>
                                        <Fingerprint className="w-5 h-5" />
                                    </div>
                                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center gap-1 font-mono">
                                        <Cpu className="w-2.5 h-2.5" />
                                        TPM / Enclave
                                    </span>
                                </div>
                                <div>
                                    <h4 className="text-xs font-bold text-zinc-100 mb-0.5">المصادقة العتادية / البصمة</h4>
                                    <p className="text-[11px] text-zinc-400 leading-tight">
                                        Windows Hello / Touch ID / Android
                                    </p>
                                    {!isHardwareSupported && (
                                        <p className="text-[10px] text-amber-400/90 mt-1 leading-snug">
                                            {hardwareStatusMessage || "غير مدعوم على هذا المتصفح/الجهاز"}
                                        </p>
                                    )}
                                </div>
                            </button>

                            {/* Card 2: 6-Digit PIN */}
                            <button
                                type="button"
                                onClick={() => setTrustMethod("pin")}
                                className={`p-3.5 rounded-xl border text-right transition-all flex flex-col justify-between ${
                                    trustMethod === "pin"
                                        ? "bg-indigo-950/40 border-indigo-500 shadow-sm shadow-indigo-500/20"
                                        : "bg-zinc-900/60 border-zinc-800 hover:border-zinc-700"
                                }`}
                            >
                                <div className="flex items-center justify-between w-full mb-2">
                                    <div className={`p-2 rounded-lg ${trustMethod === "pin" ? "bg-indigo-500/20 text-indigo-400" : "bg-zinc-800 text-zinc-400"}`}>
                                        <KeyRound className="w-5 h-5" />
                                    </div>
                                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700 font-mono">
                                        Software PIN
                                    </span>
                                </div>
                                <div>
                                    <h4 className="text-xs font-bold text-zinc-100 mb-0.5">رمز PIN (6 أرقام)</h4>
                                    <p className="text-[11px] text-zinc-400 leading-tight">
                                        حماية برمجية داخل المتصفح (تخضع لـ TD-10)
                                    </p>
                                </div>
                            </button>
                        </div>

                        {/* Security Disclaimer Box */}
                        <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs leading-relaxed space-y-1.5">
                            <div className="flex items-center gap-1.5 font-semibold text-amber-200">
                                <AlertTriangle className="w-4 h-4 shrink-0" />
                                <span>إقرار أمني بالوثوق في الجهاز</span>
                            </div>
                            <p>
                                {trustMethod === "webauthn_prf" ? (
                                    <span>
                                        المفتاح محمي بشريحة الأمان العتادية (TPM 2.0 / Apple Secure Enclave / Android Titan). لا يمكن فكه حتى لو تم استخراج قاعدة بيانات المتصفح من القرص.
                                    </span>
                                ) : (
                                    <span>
                                        المفتاح محمي برمجياً برمز الـ PIN. تأمين العتاد المادي يقع بالكامل على عاتق المستخدم (حيث لا يحمي وضع الـ PIN من الاستخراج غير المتصل لقاعدة البيانات).
                                    </span>
                                )}
                            </p>
                            <p className="font-medium text-amber-200">
                                ⚠️ يُحظر تفعيل هذا الخيار على الحواسب العامة، المشتركة، أو المقاهي.
                            </p>
                        </div>

                        {/* Agreement Checkbox */}
                        <label className="flex items-start gap-2.5 p-2.5 rounded-lg border border-zinc-800 bg-zinc-900/50 cursor-pointer hover:bg-zinc-900 transition-colors">
                            <input
                                type="checkbox"
                                checked={agreementChecked}
                                onChange={(e) => setAgreementChecked(e.target.checked)}
                                className="mt-0.5 w-4 h-4 rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-indigo-500"
                            />
                            <span className="text-xs text-zinc-300 leading-snug">
                                أقر بأن هذا حاسوبي الشخصي الموثوق، وأوافق على تمكين هذا النمط.
                            </span>
                        </label>

                        {/* Master Password Input if Vault is Locked */}
                        {!sessionKeyStore.hasMasterKey() && (
                            <div className="space-y-1.5 p-3 rounded-xl bg-zinc-900 border border-zinc-800">
                                <label className="block text-xs font-medium text-zinc-300">
                                    كلمة المرور الرئيسية للخزنة
                                </label>
                                <input
                                    type="password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    placeholder="أدخل كلمة المرور لتأكيد التوثيق..."
                                    className="w-full px-3 py-2 text-sm rounded-lg bg-zinc-950 border border-zinc-700 text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 font-mono"
                                    dir="ltr"
                                />
                                <p className="text-[11px] text-zinc-400">
                                    مطلوبة مرة واحدة لفك تشفير المفتاح الرئيسي وتغليفه على هذا الجهاز محلياً.
                                </p>
                            </div>
                        )}

                        {/* PIN Inputs (Shown only if PIN method selected) */}
                        {trustMethod === "pin" && (
                            <div className="grid grid-cols-2 gap-3 animate-in fade-in duration-150">
                                <div className="space-y-1.5">
                                    <label className="block text-xs font-medium text-zinc-400">
                                        رمز PIN (6 أرقام)
                                    </label>
                                    <input
                                        type="password"
                                        maxLength={6}
                                        inputMode="numeric"
                                        pattern="[0-9]*"
                                        placeholder="••••••"
                                        value={pin}
                                        onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                                        className="w-full px-3 py-2 text-center tracking-widest text-lg font-mono rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                                        dir="ltr"
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <label className="block text-xs font-medium text-zinc-400">
                                        تأكيد رمز PIN
                                    </label>
                                    <input
                                        type="password"
                                        maxLength={6}
                                        inputMode="numeric"
                                        pattern="[0-9]*"
                                        placeholder="••••••"
                                        value={confirmPin}
                                        onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                                        className="w-full px-3 py-2 text-center tracking-widest text-lg font-mono rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                                        dir="ltr"
                                    />
                                </div>
                            </div>
                        )}

                        {/* Error Alert */}
                        {error && (
                            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs flex items-center gap-2">
                                <AlertTriangle className="w-4 h-4 shrink-0" />
                                <span>{error}</span>
                            </div>
                        )}

                        {/* Submit Button */}
                        <button
                            type="button"
                            onClick={handleSaveDeviceTrust}
                            disabled={
                                isLoading ||
                                !agreementChecked ||
                                (trustMethod === "pin" && (pin.length !== 6 || confirmPin.length !== 6))
                            }
                            className="w-full py-2.5 px-4 rounded-xl font-medium text-sm text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/20 cursor-pointer"
                        >
                            {isLoading ? (
                                <>
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    <span>جاري تشفير وتوثيق الجهاز...</span>
                                </>
                            ) : trustMethod === "webauthn_prf" ? (
                                <>
                                    <Fingerprint className="w-4 h-4" />
                                    <span>تأكيد وتفعيل عبر البصمة / Windows Hello</span>
                                </>
                            ) : (
                                <>
                                    <Lock className="w-4 h-4" />
                                    <span>تأكيد وتفعيل رمز الـ PIN (6 أرقام)</span>
                                </>
                            )}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

