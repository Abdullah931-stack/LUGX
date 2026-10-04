import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { EDITOR_AUTOSAVE_DEBOUNCE_MS } from '@/config/editor.config';

export interface UseEditorAutosaveOptions {
  fileId: string;
  debounceMs?: number;
  isWriteLocked: boolean;
  isBlocked: () => boolean;
  persist: (content: string, targetFileId: string) => Promise<void>;
  flushOnUnmount: (content: string, targetFileId: string) => void;
  getContent: () => string | null;
  onUserEdit?: (content: string) => void;
}

export interface UseEditorAutosaveReturn {
  isDirty: boolean;
  canAutoSave: () => boolean;
  handleEditorChange: (content: string) => void;
  cancelAutosave: () => void;
  markClean: () => void;
  markDirty: () => void;
}

export function useEditorAutosave({
  fileId,
  debounceMs = EDITOR_AUTOSAVE_DEBOUNCE_MS,
  isWriteLocked,
  isBlocked,
  persist,
  flushOnUnmount,
  getContent,
  onUserEdit,
}: UseEditorAutosaveOptions): UseEditorAutosaveReturn {
  const [isDirty, setIsDirty] = useState(false);
  const isDirtyRef = useRef(false);
  const lastContentRef = useRef<string | null>(null);

  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Latest ref pattern to avoid render-time reads
  const optsRef = useRef({
    fileId,
    isWriteLocked,
    isBlocked,
    persist,
    flushOnUnmount,
    getContent,
    onUserEdit,
  });

  useLayoutEffect(() => {
    optsRef.current = {
      fileId,
      isWriteLocked,
      isBlocked,
      persist,
      flushOnUnmount,
      getContent,
      onUserEdit,
    };
  });

  const canAutoSave = useCallback(() => {
    const { isWriteLocked, isBlocked } = optsRef.current;
    if (isWriteLocked) return false;
    if (isBlocked()) return false;
    return true;
  }, []);

  const cancelAutosave = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const markClean = useCallback(() => {
    setIsDirty(false);
    isDirtyRef.current = false;
    lastContentRef.current = null;
  }, []);

  const markDirty = useCallback(() => {
    setIsDirty(true);
    isDirtyRef.current = true;
  }, []);

  const handleEditorChange = useCallback((content: string) => {
    const { onUserEdit, fileId } = optsRef.current;
    
    if (onUserEdit) {
      onUserEdit(content);
    }
    
    setIsDirty(true);
    isDirtyRef.current = true;
    lastContentRef.current = content;
    
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    
    const targetFileId = fileId;
    
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      
      const { isWriteLocked, isBlocked, persist, fileId: currentFileId } = optsRef.current;
      
      if (targetFileId !== currentFileId) {
        return;
      }
      
      if (isWriteLocked || isBlocked()) {
        return;
      }
      
      persist(content, targetFileId).catch(err => {
        console.error("Autosave persist error:", err);
      });
    }, debounceMs);
  }, [debounceMs]);

  // When write lock releases, if we are dirty, re-trigger a save
  useEffect(() => {
    if (!isWriteLocked && isDirtyRef.current) {
      const { getContent, isBlocked, fileId } = optsRef.current;
      if (!isBlocked()) {
         if (!timerRef.current) {
             timerRef.current = setTimeout(() => {
                timerRef.current = null;
                const latest = optsRef.current;
                if (!latest.isWriteLocked && !latest.isBlocked() && latest.fileId === fileId) {
                    const latestContent = latest.getContent();
                    if (latestContent !== null) {
                        latest.persist(latestContent, fileId).catch(console.error);
                    }
                }
             }, debounceMs);
         }
      }
    }
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isWriteLocked, debounceMs]);

  // Cancel on fileId change
  useEffect(() => {
    return () => {
      cancelAutosave();
    };
  }, [fileId, cancelAutosave]);

  // Unmount flush
  useEffect(() => {
    return () => {
      cancelAutosave();
      if (isDirtyRef.current) {
        const { flushOnUnmount, getContent, fileId } = optsRef.current;
        const content = lastContentRef.current ?? getContent();
        if (content !== null) {
          flushOnUnmount(content, fileId);
        }
      }
    };
  }, [cancelAutosave]);

  return {
    isDirty,
    canAutoSave,
    handleEditorChange,
    cancelAutosave,
    markClean,
    markDirty,
  };
}
