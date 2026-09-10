"use client";

import { useState, useEffect } from "react";
import { Shield, Copy, Check, AlertTriangle, ArrowLeft, Loader2, Lock } from "lucide-react";
import { cryptoWorkerBridge, wipeBuffer, arrayBufferToBase64 } from "@/lib/sync/crypto-worker-bridge";
import { sessionKeyStore } from "@/lib/sync/session-key-store";
import { createUserVaultProfile } from "@/server/actions/vault-actions";
import { indexedDBManager } from "@/lib/sync/indexeddb";
import { broadcastCrossTabEvent } from "@/lib/sync/cross-tab-sync";

interface CreateVaultModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSuccess: () => void;
    userId: string;
}

type Step = "password" | "seed" | "verify" | "activating";

export function CreateVaultModal({ isOpen, onClose, onSuccess, userId }: CreateVaultModalProps) {
    const [step, setStep] = useState<Step>("password");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [passwordError, setPasswordError] = useState<string | null>(null);

    const [mnemonic, setMnemonic] = useState<string>("");
    const [words, setWords] = useState<string[]>([]);
    const [copied, setCopied] = useState(false);

    // Verification challenge: 3 random indices (1-indexed for user display, 0-indexed internally)
    const [challengeIndices, setChallengeIndices] = useState<number[]>([2, 5, 9]);
    const [challengeInputs, setChallengeInputs] = useState<{ [index: number]: string }>({});
    const [verifyError, setVerifyError] = useState<string | null>(null);

    const [isLoading, setIsLoading] = useState(false);
    const [generalError, setGeneralError] = useState<string | null>(null);

    // Reset state on modal open
    useEffect(() => {
        if (isOpen) {
            setStep("password");
            setPassword("");
            setConfirmPassword("");
            setPasswordError(null);
            setMnemonic("");
            setWords([]);
            setCopied(false);
            setChallengeInputs({});
            setVerifyError(null);
            setIsLoading(false);
            setGeneralError(null);
        }
    }, [isOpen]);

    if (!isOpen) return null;

    // Handle moving from password to mnemonic generation
    async function handleProceedToSeed() {
        if (password.length < 8) {
            setPasswordError("يجب أن تتكون كلمة المرور من 8 أحرف على الأقل.");
            return;
        }
        if (password !== confirmPassword) {
            setPasswordError("كلمتا المرور غير متطابقتين.");
            return;
        }

        setPasswordError(null);
        setIsLoading(true);

        try {
            // Generate 12-word BIP-39 mnemonic phrase
            const generatedMnemonic = await cryptoWorkerBridge.generateMnemonic(16);
            const wordList = generatedMnemonic.trim().split(/\s+/);

            setMnemonic(generatedMnemonic);
            setWords(wordList);

            // Randomly select 3 distinct indices from 0 to 11
            const indices: number[] = [];
            while (indices.length < 3) {
                const rand = Math.floor(Math.random() * 12);
                if (!indices.includes(rand)) {
                    indices.push(rand);
                }
            }
            indices.sort((a, b) => a - b);
            setChallengeIndices(indices);
            setChallengeInputs({});

            setStep("seed");
        } catch (err: unknown) {
            setGeneralError("فشل في توليد بذرة الاسترجاع: " + ((err as Error)?.message || "خطأ غير معروف"));
        } finally {
            setIsLoading(false);
        }
    }

    // Copy mnemonic to clipboard
    function handleCopyMnemonic() {
        if (!mnemonic) return;
        navigator.clipboard.writeText(mnemonic);
        setCopied(true);
        setTimeout(() => setCopied(false), 3000);
    }

    // Handle verification step validation
    function handleVerifyChallenge() {
        for (const idx of challengeIndices) {
            const expected = words[idx];
            const entered = (challengeInputs[idx] || "").trim().toLowerCase();
            if (entered !== expected.toLowerCase()) {
                setVerifyError(`الكلمة رقم #${idx + 1} غير صحيحة. يرجى المراجعة بدقة.`);
                return;
            }
        }

        setVerifyError(null);
        handleActivateVault();
    }

    // Final activation: derive keys and save profile
    async function handleActivateVault() {
        setStep("activating");
        setIsLoading(true);
        setGeneralError(null);

        let masterKeyRaw: Uint8Array | null = null;
        let passBytes: Uint8Array | null = null;
        let saltBytes: Uint8Array | null = null;
        let recoverySaltBytes: Uint8Array | null = null;
        let kekPass: Uint8Array | null = null;
        let kekSeed: Uint8Array | null = null;
        let ivPass: Uint8Array | null = null;
        let ivSeed: Uint8Array | null = null;

        try {
            // 1. Generate 256-bit Master Key
            masterKeyRaw = await cryptoWorkerBridge.generateRandomBytes(32);

            // 2. Generate salts
            saltBytes = await cryptoWorkerBridge.generateRandomBytes(16);
            recoverySaltBytes = await cryptoWorkerBridge.generateRandomBytes(16);

            // 3. Derive KEK-Pass from password
            const encoder = new TextEncoder();
            passBytes = encoder.encode(password);
            kekPass = await cryptoWorkerBridge.deriveKeyRaw(passBytes, saltBytes, 600000, 256);

            // 4. Wrap Master Key with KEK-Pass
            ivPass = await cryptoWorkerBridge.generateRandomBytes(12);
            const passWrapResult = await cryptoWorkerBridge.wrapKeyRaw(
                kekPass,
                masterKeyRaw,
                ivPass,
                `vault:pass:${userId}`
            );

            // 5. Derive KEK-Seed from 12-word mnemonic
            const seedBytes = await cryptoWorkerBridge.mnemonicToSeed(mnemonic, recoverySaltBytes, 600000);
            kekSeed = seedBytes.slice(0, 32);

            // 6. Wrap Master Key with KEK-Seed
            ivSeed = await cryptoWorkerBridge.generateRandomBytes(12);
            const seedWrapResult = await cryptoWorkerBridge.wrapKeyRaw(
                kekSeed,
                masterKeyRaw,
                ivSeed,
                `vault:seed:${userId}`
            );

            const payload = {
                encryptedMasterKey: JSON.stringify({
                    ciphertext: passWrapResult.wrappedKeyBase64,
                    iv: passWrapResult.ivBase64,
                }),
                recoveryEncryptedMasterKey: JSON.stringify({
                    ciphertext: seedWrapResult.wrappedKeyBase64,
                    iv: seedWrapResult.ivBase64,
                }),
                keySalt: arrayBufferToBase64(saltBytes),
                recoverySalt: arrayBufferToBase64(recoverySaltBytes),
                kdfIterations: 600000,
                keyVersion: 1,
            };

            // 7. Save vault profile to local IndexedDB cache (Offline-First support)
            try {
                const idb = indexedDBManager.getUserId() ? indexedDBManager : null;
                if (idb) {
                    await idb.saveCachedVaultProfile({
                        userId,
                        ...payload,
                        createdAt: new Date(),
                        updatedAt: new Date(),
                    });
                }
            } catch (idbErr) {
                console.warn("[CreateVaultModal] Failed to cache profile in IDB:", idbErr);
            }

            // 8. Attempt server persistence if online (non-blocking failure)
            try {
                const res = await createUserVaultProfile(payload);
                if (!res.success && res.status !== "conflict") {
                    console.warn("[CreateVaultModal] Server save warning:", res.error);
                }
            } catch (serverErr) {
                console.warn("[CreateVaultModal] Offline server sync deferred:", serverErr);
            }

            // 9. Deposit Master Key in volatile memory
            sessionKeyStore.setMasterKey(masterKeyRaw, 1);

            broadcastCrossTabEvent({
                type: "vault_unlocked",
            });

            onSuccess();
            onClose();
        } catch (err: unknown) {
            console.error("[CreateVaultModal] Activation error:", err);
            setGeneralError("فشل تفعيل الخزنة: " + ((err as Error)?.message || "خطأ غير متوقع"));
            setStep("verify");
        } finally {
            // Defensive RAM sanitization
            if (passBytes) wipeBuffer(passBytes);
            if (saltBytes) wipeBuffer(saltBytes);
            if (recoverySaltBytes) wipeBuffer(recoverySaltBytes);
            if (kekPass) wipeBuffer(kekPass);
            if (kekSeed) wipeBuffer(kekSeed);
            if (ivPass) wipeBuffer(ivPass);
            if (ivSeed) wipeBuffer(ivSeed);
            if (masterKeyRaw) wipeBuffer(masterKeyRaw);
            setIsLoading(false);
        }
    }

    return (
        <>
            {/* Backdrop */}
            <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 transition-opacity" onClick={onClose} />

            {/* Modal Dialog */}
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl w-full max-w-lg overflow-hidden text-right" dir="rtl">
                    {/* Header */}
                    <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between">
                        <div className="flex items-center gap-2.5">
                            <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                                <Shield className="w-5 h-5" />
                            </div>
                            <div>
                                <h3 className="text-base font-semibold text-zinc-100">إنشاء الخزنة المشفرة (Zero-Knowledge)</h3>
                                <p className="text-xs text-zinc-400">تشفير كامل طرف-إلى-طرف بمفتاح لا يعرفه سواك</p>
                            </div>
                        </div>
                    </div>

                    {/* Progress Indicator */}
                    <div className="px-6 pt-4 flex items-center justify-between text-xs text-zinc-500 border-b border-zinc-800/40 pb-3">
                        <span className={step === "password" ? "text-indigo-400 font-semibold" : "text-zinc-500"}>1. كلمة المرور</span>
                        <ArrowLeft className="w-3 h-3 text-zinc-600" />
                        <span className={step === "seed" ? "text-indigo-400 font-semibold" : "text-zinc-500"}>2. بذرة الاسترجاع (12 كلمة)</span>
                        <ArrowLeft className="w-3 h-3 text-zinc-600" />
                        <span className={step === "verify" || step === "activating" ? "text-indigo-400 font-semibold" : "text-zinc-500"}>3. اختبار التحقق</span>
                    </div>

                    {/* Body */}
                    <div className="p-6">
                        {generalError && (
                            <div className="mb-4 p-3 rounded-lg bg-red-950/40 border border-red-800/40 text-red-300 text-xs flex items-center gap-2">
                                <AlertTriangle className="w-4 h-4 shrink-0" />
                                <span>{generalError}</span>
                            </div>
                        )}

                        {/* STEP 1: Password Entry */}
                        {step === "password" && (
                            <div className="space-y-4">
                                <p className="text-xs text-zinc-400 leading-relaxed">
                                    عيّن كلمة مرور رئيسية قوية لفتح الخزنة. لا يتم إرسال هذه الكلمة مطلقاً لأي خادم ولا يمكن استعادتها إن فُقدت إلا عبر بذرة الـ 12 كلمة.
                                </p>

                                <div>
                                    <label className="block text-xs font-medium text-zinc-300 mb-1.5">كلمة مرور الخزنة</label>
                                    <input
                                        type="password"
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        placeholder="••••••••••••"
                                        className="w-full px-3 py-2 bg-zinc-800/80 border border-zinc-700 rounded-lg text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 text-left"
                                        dir="ltr"
                                        autoFocus
                                    />
                                </div>

                                <div>
                                    <label className="block text-xs font-medium text-zinc-300 mb-1.5">تأكيد كلمة المرور</label>
                                    <input
                                        type="password"
                                        value={confirmPassword}
                                        onChange={(e) => setConfirmPassword(e.target.value)}
                                        placeholder="••••••••••••"
                                        className="w-full px-3 py-2 bg-zinc-800/80 border border-zinc-700 rounded-lg text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 text-left"
                                        dir="ltr"
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter") handleProceedToSeed();
                                        }}
                                    />
                                </div>

                                {passwordError && (
                                    <p className="text-xs text-red-400">{passwordError}</p>
                                )}
                            </div>
                        )}

                        {/* STEP 2: 12-Word Recovery Phrase */}
                        {step === "seed" && (
                            <div className="space-y-4">
                                <div className="p-3 rounded-lg bg-amber-950/30 border border-amber-800/40 text-amber-300 text-xs flex items-start gap-2">
                                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                                    <span>
                                        احفظ هذه الكلمات الـ 12 في مكان آمن وخاص. هذه البذرة هي وسيلتك الوحيدة لاسترجاع ملفاتك المشفرة عند نسيان كلمة المرور.
                                    </span>
                                </div>

                                {/* Words Grid */}
                                <div className="grid grid-cols-3 gap-2 p-3 bg-zinc-950/60 rounded-lg border border-zinc-800/80" dir="ltr">
                                    {words.map((word, idx) => (
                                        <div key={idx} className="flex items-center gap-1.5 px-2.5 py-1.5 bg-zinc-900/90 rounded border border-zinc-800 text-xs">
                                            <span className="text-zinc-500 font-mono text-[10px] w-4">{idx + 1}.</span>
                                            <span className="text-zinc-200 font-mono font-medium">{word}</span>
                                        </div>
                                    ))}
                                </div>

                                <div className="flex justify-end">
                                    <button
                                        onClick={handleCopyMnemonic}
                                        className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
                                    >
                                        {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                                        <span>{copied ? "تم النسخ بنجاح" : "نسخ الكلمات الـ 12"}</span>
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* STEP 3: Verification Challenge */}
                        {step === "verify" && (
                            <div className="space-y-4">
                                <p className="text-xs text-zinc-400 leading-relaxed">
                                    للتأكد من قيامك بحفظ بذرة الاسترجاع، يُرجى إدخال الكلمات المطلوبة أدناه بحسب رقمها:
                                </p>

                                <div className="space-y-3">
                                    {challengeIndices.map((idx) => (
                                        <div key={idx} className="flex items-center gap-3">
                                            <span className="text-xs font-medium text-indigo-400 w-24">الكلمة رقم #{idx + 1}:</span>
                                            <input
                                                type="text"
                                                value={challengeInputs[idx] || ""}
                                                onChange={(e) =>
                                                    setChallengeInputs({
                                                        ...challengeInputs,
                                                        [idx]: e.target.value,
                                                    })
                                                }
                                                placeholder={`أدخل الكلمة #${idx + 1}`}
                                                className="flex-1 px-3 py-1.5 bg-zinc-800/80 border border-zinc-700 rounded text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-mono text-left"
                                                dir="ltr"
                                            />
                                        </div>
                                    ))}
                                </div>

                                {verifyError && (
                                    <p className="text-xs text-red-400 mt-2">{verifyError}</p>
                                )}
                            </div>
                        )}

                        {/* STEP 4: Activating */}
                        {step === "activating" && (
                            <div className="py-8 flex flex-col items-center justify-center gap-3 text-center">
                                <Loader2 className="w-8 h-8 animate-spin text-indigo-400" />
                                <h4 className="text-sm font-semibold text-zinc-200">جاري اشتقاق المفاتيح وتفعيل الخزنة...</h4>
                                <p className="text-xs text-zinc-500">تطبيق التشفير المزدوج وتطهير الذاكرة الحية</p>
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

                        <div className="flex items-center gap-2">
                            {step === "password" && (
                                <button
                                    onClick={handleProceedToSeed}
                                    disabled={isLoading}
                                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer"
                                >
                                    {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                                    <span>المتابعة للبذرة</span>
                                    <ArrowLeft className="w-3.5 h-3.5" />
                                </button>
                            )}

                            {step === "seed" && (
                                <button
                                    onClick={() => setStep("verify")}
                                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer"
                                >
                                    <span>تأكيد الحفظ واختبار التحقق</span>
                                    <ArrowLeft className="w-3.5 h-3.5" />
                                </button>
                            )}

                            {step === "verify" && (
                                <button
                                    onClick={handleVerifyChallenge}
                                    disabled={isLoading}
                                    className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer"
                                >
                                    {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Lock className="w-3.5 h-3.5" />}
                                    <span>تفعيل الخزنة الآن</span>
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </>
    );
}
