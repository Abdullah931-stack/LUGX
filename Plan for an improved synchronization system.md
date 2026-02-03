## المرحلة الأولى: البنية التحتية للتخزين المحلي

## إعداد IndexedDB

- إنشاء قاعدة بيانات `textai_db` بإصدار (Version) محدد
    
- إنشاء ثلاثة Object Stores منفصلة:
    
    - `files`: لتخزين محتوى الملفات الكاملة
        
    - `operations`: لتسجيل كل عملية تحرير (Operation Log)
        
    - `sync_metadata`: لحفظ حالة المزامنة والـ ETags
        

## بنية كائن الملف

text

`{   id: string,  content: string,  etag: string,  lastModified: timestamp,  lastSyncedAt: timestamp,  isDirty: boolean,  version: number }`

## بنية سجل العمليات

text

`{   id: string,  fileId: string,  operationType: 'insert' | 'delete' | 'update',  position: number,  content: string,  timestamp: timestamp,  synced: boolean }`

## المرحلة الثانية: طبقة المزامنة (Sync Layer)

## آلية الكشف عن الاتصال

- استخدام **Navigator.onLine API** للكشف الفوري
    
- تسجيل `online` و `offline` event listeners
    
- تطبيق **Exponential Backoff** عند فشل الطلبات:
    
    - المحاولة الأولى: فورية
        
    - الثانية: بعد 2 ثانية
        
    - الثالثة: بعد 4 ثوانٍ
        
    - وهكذا حتى 60 ثانية كحد أقصى
        

## Background Sync API

- تسجيل Service Worker في التطبيق
    
- استخدام `registration.sync.register('sync-files')` عند حفظ دون اتصال
    
- معالجة حدث `sync` في Service Worker لإرسال التعديلات المعلقة (Pending Changes)
    

## المرحلة الثالثة: بروتوكول المزامنة مع الخادم

## نقاط النهاية المطلوبة (API Endpoints)

**جلب التحديثات الجماعية:**

text

`GET /api/files/sync?updated_after={timestamp}&limit=50 Response: {   files: [{id, content, etag, updated_at}],  has_more: boolean,  next_cursor: string }`

**جلب ملف مفرد بشروط:**

text

`GET /api/files/{id} Headers: If-None-Match: {etag} Response: 304 Not Modified أو 200 مع محتوى جديد + etag جديد`

**تحديث ملف مع حماية التعارض:**

text

`PUT /api/files/{id} Headers: If-Match: {etag} Body: {content, operations: [...]} Response:    - 200: نجح التحديث + etag جديد  - 412 Precondition Failed: تعارض مكتشف`

## خوارزمية المزامنة عند الاتصال

1. **جلب القائمة الكاملة للملفات المحدثة:**
    
    - إرسال `lastSyncedAt` من `sync_metadata`
        
    - معالجة الاستجابة pagination بشكل متكرر
        
2. **لكل ملف محلي بعلامة `isDirty = true`:**
    
    - إرسال `PUT` مع `If-Match: {etag}`
        
    - إذا كانت الاستجابة `412`:
        
        - جلب النسخة من الخادم
            
        - تفعيل آلية حل التعارض
            
3. **دمج الملفات الواردة من الخادم:**
    
    - مقارنة `etag` المحلي بالوارد
        
    - إذا اختلفا وكان الملف محلياً ليس `isDirty`: تحديث مباشر
        
    - إذا اختلفا والملف `isDirty`: تفعيل آلية حل التعارض
        
4. **تحديث `sync_metadata`:**
    
    - حفظ `lastSyncedAt` الجديد
        
    - مسح علامة `isDirty` للملفات المزامنة
        

## المرحلة الرابعة: حل التعارضات (Conflict Resolution)

## آلية الكشف الدقيق

عند استلام `412 Precondition Failed`:

javascript

`const conflict = {   fileId: string,  localVersion: {content, etag, lastModified},  serverVersion: {content, etag, lastModified},  operations: Operation[] // من operations store }`

## استراتيجية الدمج التلقائي

- استخدام **Diff Algorithm** (مثل مكتبة `diff-match-patch`)
    
- إذا كانت التعديلات على أجزاء مختلفة (Non-Overlapping):
    
    - دمج تلقائي بـ **Three-Way Merge**
        
    - عرض إشعار للمستخدم بالدمج الناجح
        
- إذا كانت على نفس الأجزاء (Overlapping):
    
    - الانتقال للحل اليدوي
        

## واجهة الحل اليدوي

مكونات UI مطلوبة:

- عرض النسخة المحلية في عمود يسار
    
- عرض النسخة من الخادم في عمود يمين
    
- تمييز الاختلافات بالألوان (Highlighting)
    
- أزرار: "قبول المحلي" | "قبول الخادم" | "دمج يدوي"
    
- محرر للدمج اليدوي مع معاينة مباشرة (Live Preview)
    

## المرحلة الخامسة: التحسينات المتقدمة

## Delta Sync للأداء

بدلاً من إرسال الملف كاملاً:

- حساب **JSON Patch** (RFC 6902) للتغييرات فقط
    
- إرسال العمليات من `operations` store:
    

text

`[   {op: "replace", path: "/lines/5", value: "نص جديد"},  {op: "add", path: "/lines/12", value: "فقرة مضافة"} ]`

- الخادم يطبق الـ Patch على نسخته
    

## Optimistic UI Updates

- تطبيق التغييرات فوراً على الواجهة (Optimistic Update)
    
- حفظ في IndexedDB مع علامة `isDirty = true`
    
- عند فشل المزامنة: عرض شارة تحذير بجانب الملف
    
- عند النجاح: إزالة العلامة وتحديث الـ `etag`
    

## Queue Management

- إنشاء **Sync Queue** لترتيب العمليات المعلقة:
    
    - أولوية عالية: ملفات فُتحت مؤخراً
        
    - أولوية متوسطة: ملفات مُعدّلة دون اتصال
        
    - أولوية منخفضة: ملفات قديمة للتحقق من تحديثات
        

## المرحلة السادسة: الأمان والصيانة

## تشفير البيانات الحساسة

javascript

`// عند الحفظ const key = await generateEncryptionKey(); const encrypted = await crypto.subtle.encrypt(   {name: "AES-GCM", iv: randomIV},  key,  contentBuffer ); // حفظ encrypted في IndexedDB`

## إدارة المساحة

- رصد `navigator.storage.estimate()` بشكل دوري
    
- عند تجاوز 80% من الحصة (Quota):
    
    - حذف الملفات المحذوفة من الخادم (Soft Deleted)
        
    - ضغط سجل العمليات القديمة (Operations Compaction)
        
    - عرض تنبيه للمستخدم لتنظيف الملفات
        

## مراقبة الأداء (Performance Monitoring)

- تسجيل مدة كل عملية مزامنة
    
- حساب معدل نجاح المزامنة (Success Rate)
    
- رصد حجم البيانات المنقولة (Data Transfer Size)
    

## المرحلة السابعة: الاختبار والتحقق

## سيناريوهات الاختبار الحرجة

- فقدان الاتصال أثناء الحفظ
    
- تعديل نفس الملف من جهازين متزامنين
    
- امتلاء مساحة IndexedDB
    
- تزامن بعد أسابيع من العمل دون اتصال
    
- فشل عملية المزامنة في منتصفها (Partial Sync)
    

## Fallback Strategies

- عند فشل Background Sync: استخدام Polling كل 30 ثانية
    
- عند فشل IndexedDB: التراجع لـ localStorage مع تحذير محدودية الحجم
    
- عند فشل حل التعارض التلقائي: حفظ نسخة احتياطية بامتداد `.conflict`
    

## جدول التنفيذ الزمني المقترح

| المرحلة | المهام الرئيسية                                      |
| ------- | ---------------------------------------------------- |
| 1       | إعداد IndexedDB + Object Stores + بنية البيانات      |
| 2       | بناء طبقة المزامنة الأساسية + API Endpoints          |
| 3       | تطبيق Service Worker + Background Sync               |
| 4       | آلية كشف التعارضات + الدمج التلقائي                  |
| 5       | واجهة الحل اليدوي للتعارضات                          |
| 6       | Delta Sync + Optimistic UI                           |
| 7       | التشفير + إدارة المساحة                              |
| 8       | الاختبار الشامل + معالجة الحالات الحدية (Edge Cases) |

هذه الخطة توفر نظام مزامنة صناعي (Production-Grade) يحمي بيانات المستخدمين ويوفر تجربة سلسة حتى في ظروف الاتصال غير المستقر.