"use client";

import { useState, useEffect, useCallback } from "react";
import { ShieldCheck, ShieldAlert, Laptop, Trash2, Key, CheckCircle2, AlertTriangle, Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { indexedDBManager } from "@/lib/sync/indexeddb";
import { DeviceTrustEnvelope } from "@/lib/sync/types/vault";
import { revokeAllTrustedDevices, getUserVaultProfile } from "@/server/actions/vault-actions";
import { TrustDeviceModal } from "./trust-device-modal";

interface VaultSecurityCardProps {
    userId: string;
}

export function VaultSecurityCard({ userId }: VaultSecurityCardProps) {
    const [envelope, setEnvelope] = useState<DeviceTrustEnvelope | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isRevokingAll, setIsRevokingAll] = useState(false);
    const [isTrustModalOpen, setIsTrustModalOpen] = useState(false);
    const [showRevokeAllConfirm, setShowRevokeAllConfirm] = useState(false);
    const [feedbackMessage, setFeedbackMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);

    const refreshDeviceStatus = useCallback(async () => {
        setIsLoading(true);
        try {
            const env = await indexedDBManager.getDeviceTrustEnvelope(userId);
            if (env) {
                // Check expiration
                if (Date.now() > env.expiresAt) {
                    await indexedDBManager.clearDeviceTrustEnvelope(userId);
                    setEnvelope(null);
                } else {
                    // Check server epoch
                    const profileRes = await getUserVaultProfile();
                    if (profileRes.success && profileRes.data?.deviceTrustEpoch) {
                        if (profileRes.data.deviceTrustEpoch !== env.deviceTrustEpoch) {
                            await indexedDBManager.clearDeviceTrustEnvelope(userId);
                            setEnvelope(null);
                        } else {
                            setEnvelope(env);
                        }
                    } else {
                        setEnvelope(env);
                    }
                }
            } else {
                setEnvelope(null);
            }
        } catch (err) {
            console.warn("[VaultSecurityCard] Error checking device trust:", err);
            setEnvelope(null);
        } finally {
            setIsLoading(false);
        }
    }, [userId]);

    useEffect(() => {
        refreshDeviceStatus();
    }, [refreshDeviceStatus]);

    // Revoke this current device
    async function handleRevokeCurrentDevice() {
        setIsLoading(true);
        try {
            await indexedDBManager.clearDeviceTrustEnvelope(userId);
            setEnvelope(null);
            setFeedbackMessage({ text: "تم إلغاء موثوقية هذا الجهاز بنجاح والعودة للنموذج الافتراضي الصارم.", type: "success" });
            setTimeout(() => setFeedbackMessage(null), 4000);
        } catch (err) {
            console.error("[VaultSecurityCard] Revoke current device error:", err);
            setFeedbackMessage({ text: "فشل إلغاء موثوقية هذا الجهاز.", type: "error" });
        } finally {
            setIsLoading(false);
        }
    }

    // Revoke all devices globally
    async function handleRevokeAllDevices() {
        setIsRevokingAll(true);
        try {
            const res = await revokeAllTrustedDevices();
            if (res.success) {
                await indexedDBManager.clearDeviceTrustEnvelope(userId);
                setEnvelope(null);
                setShowRevokeAllConfirm(false);
                setFeedbackMessage({
                    text: "تم إبطال وإلغاء جميع الأجهزة الموثوقة بنجاح. ستطلب كافة الأجهزة كلمة المرور الكاملة.",
                    type: "success",
                });
                setTimeout(() => setFeedbackMessage(null), 5000);
            } else {
                setFeedbackMessage({ text: res.error || "فشل إلغاء الأجهزة الموثوقة عن بُعد.", type: "error" });
            }
        } catch (err) {
            console.error("[VaultSecurityCard] Revoke all error:", err);
            setFeedbackMessage({ text: "حدث خطأ غير متوقع أثناء إلغاء الأجهزة.", type: "error" });
        } finally {
            setIsRevokingAll(false);
        }
    }

    const isTrusted = !!envelope;
    const expiresDate = envelope?.expiresAt ? new Date(envelope.expiresAt).toLocaleDateString() : null;

    return (
        <Card className="border-zinc-800 bg-zinc-900/30">
            <CardHeader>
                <div className="flex items-center justify-between">
                    <div className="space-y-1">
                        <CardTitle className="flex items-center gap-2 text-zinc-100">
                            <ShieldCheck className="w-5 h-5 text-indigo-400" />
                            <span>أمان الخزنة وموثوقية الأجهزة</span>
                        </CardTitle>
                        <CardDescription>
                            إدارة مستوى أمان الخزنة، صلاحية رمز PIN السريع، وإلغاء الأجهزة الموثوقة
                        </CardDescription>
                    </div>

                    {/* Badge */}
                    {!isLoading && (
                        <div
                            className={`px-3 py-1 rounded-full text-xs font-medium flex items-center gap-1.5 border ${
                                isTrusted
                                    ? "bg-indigo-500/10 border-indigo-500/30 text-indigo-300"
                                    : "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                            }`}
                        >
                            {isTrusted ? (
                                <>
                                    <Laptop className="w-3.5 h-3.5" />
                                    <span>جهاز موثوق (PIN)</span>
                                </>
                            ) : (
                                <>
                                    <ShieldCheck className="w-3.5 h-3.5" />
                                    <span>الافتراضي العام (أقصى درجات الأمان)</span>
                                </>
                            )}
                        </div>
                    )}
                </div>
            </CardHeader>

            <CardContent className="space-y-6">
                {/* Feedback Message */}
                {feedbackMessage && (
                    <div
                        className={`p-3.5 rounded-xl text-xs flex items-center gap-2 ${
                            feedbackMessage.type === "success"
                                ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-300"
                                : "bg-red-500/10 border border-red-500/20 text-red-300"
                        }`}
                    >
                        {feedbackMessage.type === "success" ? (
                            <CheckCircle2 className="w-4 h-4 shrink-0" />
                        ) : (
                            <AlertTriangle className="w-4 h-4 shrink-0" />
                        )}
                        <span>{feedbackMessage.text}</span>
                    </div>
                )}

                {/* Current Device Status Box */}
                <div className="p-4 rounded-xl border border-zinc-800 bg-zinc-950/60 space-y-3">
                    <div className="flex items-start justify-between gap-4">
                        <div className="space-y-1">
                            <h4 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
                                <Laptop className="w-4 h-4 text-zinc-400" />
                                <span>حالة هذا الجهاز الحالي</span>
                            </h4>
                            <p className="text-xs text-zinc-400 leading-relaxed">
                                {isTrusted
                                    ? `هذا الجهاز موثوق ومفعل للفتح السريع برمز PIN مكون من 4 أرقام. تنتهي الصلاحية في: ${expiresDate}.`
                                    : "يعمل هذا الجهاز بالنموذج الافتراضي العام (أقصى درجات الأمان - RAM Only). لا يتم حفظ أي مفاتيح محلياً وتُطلب كلمة المرور عند كل إغلاق للتبويب."}
                            </p>
                        </div>

                        <div className="shrink-0">
                            {isTrusted ? (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={handleRevokeCurrentDevice}
                                    disabled={isLoading}
                                    className="border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-red-400 text-xs gap-1.5"
                                >
                                    <Trash2 className="w-3.5 h-3.5" />
                                    <span>إلغاء موثوقية هذا الجهاز</span>
                                </Button>
                            ) : (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setIsTrustModalOpen(true)}
                                    disabled={isLoading}
                                    className="border-indigo-500/40 text-indigo-300 bg-indigo-500/5 hover:bg-indigo-500/15 text-xs gap-1.5"
                                >
                                    <Key className="w-3.5 h-3.5" />
                                    <span>توثيق هذا الجهاز بـ PIN</span>
                                </Button>
                            )}
                        </div>
                    </div>
                </div>

                {/* Global Revocation Danger Zone */}
                <div className="p-4 rounded-xl border border-red-500/20 bg-red-500/5 space-y-3">
                    <div className="flex items-start justify-between gap-4">
                        <div className="space-y-1">
                            <h4 className="text-sm font-semibold text-red-300 flex items-center gap-2">
                                <ShieldAlert className="w-4 h-4 text-red-400" />
                                <span>إلغاء جميع الأجهزة الموثوقة دفعة واحدة</span>
                            </h4>
                            <p className="text-xs text-zinc-400 leading-relaxed">
                                يُبطل فورياً صلاحية رمز الـ PIN في كافة الأجهزة المسجلة كموثوقة، ويُعيد كل الأجهزة للنموذج الافتراضي الصارم ومطالبة كلمة المرور الكاملة وبذرة الاسترداد.
                            </p>
                        </div>

                        <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => setShowRevokeAllConfirm(true)}
                            disabled={isRevokingAll}
                            className="shrink-0 text-xs gap-1.5 shadow-lg shadow-red-500/20"
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                            <span>إلغاء الكل</span>
                        </Button>
                    </div>
                </div>

                {/* Revoke All Confirmation Modal */}
                {showRevokeAllConfirm && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
                        <div className="w-full max-w-md p-6 rounded-2xl bg-zinc-950 border border-red-500/30 shadow-2xl space-y-4">
                            <div className="flex items-center gap-3 text-red-400">
                                <div className="p-3 rounded-full bg-red-500/10 border border-red-500/20">
                                    <ShieldAlert className="w-6 h-6" />
                                </div>
                                <h3 className="text-lg font-bold text-zinc-100">تأكيد إلغاء كافة الأجهزة الموثوقة</h3>
                            </div>

                            <p className="text-sm text-zinc-300 leading-relaxed">
                                هل أنت متأكد من رغبتك في إبطال موثوقية جميع أجهزتك؟ سيتم حذف رموز الـ PIN وإلغاء صلاحيتها فوراً في كافة المتصفحات والأجهزة، وستتطلب جميع الأجهزة إدخال كلمة المرور الرئيسية الكاملة.
                            </p>

                            <div className="flex justify-end gap-2 pt-2">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setShowRevokeAllConfirm(false)}
                                    disabled={isRevokingAll}
                                >
                                    إلغاء
                                </Button>
                                <Button
                                    variant="destructive"
                                    size="sm"
                                    onClick={handleRevokeAllDevices}
                                    disabled={isRevokingAll}
                                    className="gap-2"
                                >
                                    {isRevokingAll ? (
                                        <>
                                            <Loader2 className="w-4 h-4 animate-spin" />
                                            <span>جاري الإلغاء...</span>
                                        </>
                                    ) : (
                                        <span>نعم، إبطال الكل الآن</span>
                                    )}
                                </Button>
                            </div>
                        </div>
                    </div>
                )}
            </CardContent>

            {/* Trust Device Setup Modal */}
            <TrustDeviceModal
                isOpen={isTrustModalOpen}
                onClose={() => setIsTrustModalOpen(false)}
                userId={userId}
                onSuccess={refreshDeviceStatus}
            />
        </Card>
    );
}
