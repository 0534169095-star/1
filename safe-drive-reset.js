(() => {
  'use strict';

  const VERSION = '2026-08-02-safe-one-click-2';
  const DELETE_CONCURRENCY = 2;
  const BUTTON_ID = 'safeDriveCleanupButton';
  let activeRun = null;
  let uiObserver = null;

  const safeId = value => String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120);

  function assertReady() {
    if (!window.state?.isSuperAdmin) {
      throw new Error('הפעולה זמינה רק למנהל־על.');
    }
    if (!window.db) {
      throw new Error('החיבור למסד הנתונים עדיין לא מוכן.');
    }
    if (typeof window.deleteImageCloud !== 'function' || typeof window.deleteFolderCloud !== 'function') {
      throw new Error('מנגנון המחיקה של האתר עדיין לא מוכן.');
    }
  }

  function isDriveImage(image) {
    return Boolean(
      safeId(image?.id)
      && image?.syncedFromDrive === true
      && String(image?.driveFileId || '').trim()
    );
  }

  function isDriveFolder(folder) {
    return Boolean(
      safeId(folder?.id)
      && folder?.syncedFromDrive === true
      && String(folder?.driveFolderId || '').trim()
    );
  }

  function collectCandidates() {
    const images = [...(window.state?.images || [])].filter(isDriveImage);
    const folders = [...(window.state?.folders || [])].filter(isDriveFolder);
    return { images, folders };
  }

  function makePreview() {
    const { images, folders } = collectCandidates();
    return Object.freeze({
      version: VERSION,
      imageCount: images.length,
      folderCount: folders.length,
      imageIds: images.map(image => safeId(image.id)),
      folderIds: folders.map(folder => safeId(folder.id)),
      manualImagesProtected: (window.state?.images || []).filter(image => !isDriveImage(image)).length,
      automatic: false
    });
  }

  function emitProgress(detail) {
    window.dispatchEvent(new CustomEvent('safe-drive-cleanup-progress', { detail }));
    console.info('[Safe Drive cleanup]', detail);
  }

  function setButtonState({ running = false, text = '' } = {}) {
    const button = document.getElementById(BUTTON_ID);
    if (!button) return;
    button.disabled = running;
    button.textContent = text || getButtonLabel();
    button.classList.toggle('opacity-60', running);
    button.classList.toggle('cursor-wait', running);
  }

  function getButtonLabel() {
    const preview = makePreview();
    return preview.imageCount > 0
      ? `מחק קובצי Drive ישנים (${preview.imageCount})`
      : 'אין קובצי Drive ישנים למחיקה';
  }

  async function runPool(items, worker, concurrency = DELETE_CONCURRENCY) {
    let cursor = 0;
    const completed = [];
    const failed = [];

    async function runner() {
      while (cursor < items.length) {
        const item = items[cursor++];
        try {
          await worker(item);
          completed.push(item);
        } catch (error) {
          failed.push({ item, error });
        }
        emitProgress({
          phase: 'deleting-images',
          completed: completed.length,
          failed: failed.length,
          total: items.length
        });
        setButtonState({
          running: true,
          text: `מוחק ${completed.length + failed.length} מתוך ${items.length}...`
        });
      }
    }

    const runners = Math.max(1, Math.min(concurrency, items.length || 1));
    await Promise.all(Array.from({ length: runners }, runner));
    return { completed, failed };
  }

  async function deleteDriveImage(image) {
    const imageId = safeId(image?.id);
    if (!imageId) throw new Error('מזהה תמונה לא תקין.');
    await window.deleteImageCloud(imageId);
  }

  async function deleteDriveFolder(folder) {
    const folderId = safeId(folder?.id);
    if (!folderId) throw new Error('מזהה תיקייה לא תקין.');
    await window.deleteFolderCloud(folderId);
  }

  async function executeCleanup(options = {}) {
    assertReady();

    const preview = makePreview();
    const dryRun = options.dryRun !== false;

    if (dryRun) {
      emitProgress({ phase: 'preview', ...preview });
      return { ok: true, dryRun: true, preview };
    }

    if (options.confirmed !== true) {
      throw new Error('המחיקה לא אושרה.');
    }

    if (preview.imageCount === 0 && preview.folderCount === 0) {
      window.showNotification?.('אין קובצי Drive ישנים למחיקה.', true);
      return { ok: true, dryRun: false, deletedImages: 0, deletedFolders: 0, failures: [] };
    }

    const { images, folders } = collectCandidates();
    emitProgress({ phase: 'starting', imageCount: images.length, folderCount: folders.length });
    setButtonState({ running: true, text: `מתחיל מחיקה של ${images.length} קבצים...` });

    const imageResult = await runPool(images, deleteDriveImage);

    const succeededImageIds = new Set(imageResult.completed.map(image => safeId(image.id)));
    window.state.images = (window.state.images || []).filter(image => !succeededImageIds.has(safeId(image?.id)));
    window.renderImages?.();
    window.renderGallery?.();

    if (imageResult.failed.length > 0) {
      const result = {
        ok: false,
        dryRun: false,
        deletedImages: imageResult.completed.length,
        deletedFolders: 0,
        failures: imageResult.failed.map(({ item, error }) => ({
          id: safeId(item?.id),
          message: error?.message || String(error)
        }))
      };
      emitProgress({ phase: 'stopped-on-error', ...result });
      window.showNotification?.(
        `המחיקה נעצרה: ${result.failures.length} קבצים לא נמחקו. לא נמחקו תיקיות.`,
        false
      );
      return result;
    }

    const folderResult = await runPool(folders, deleteDriveFolder, 1);
    const succeededFolderIds = new Set(folderResult.completed.map(folder => safeId(folder.id)));
    window.state.folders = (window.state.folders || []).filter(folder => !succeededFolderIds.has(safeId(folder?.id)));

    if (window.state.activeFolderId && succeededFolderIds.has(safeId(window.state.activeFolderId))) {
      window.state.activeFolderId = 'all';
    }

    window.renderFolders?.();
    window.populateFolderSelects?.();

    if (folderResult.failed.length > 0) {
      const result = {
        ok: false,
        dryRun: false,
        deletedImages: imageResult.completed.length,
        deletedFolders: folderResult.completed.length,
        failures: folderResult.failed.map(({ item, error }) => ({
          id: safeId(item?.id),
          message: error?.message || String(error)
        }))
      };
      emitProgress({ phase: 'folder-error', ...result });
      window.showNotification?.('הקבצים נמחקו, אך חלק מרשומות התיקיות לא נמחקו.', false);
      return result;
    }

    const result = {
      ok: true,
      dryRun: false,
      deletedImages: imageResult.completed.length,
      deletedFolders: folderResult.completed.length,
      failures: []
    };
    emitProgress({ phase: 'complete', ...result });
    window.showNotification?.(
      `המחיקה הסתיימה: ${result.deletedImages} קובצי Drive נמחקו. העלאות ידניות נשמרו.`,
      true
    );
    return result;
  }

  async function handleOneClickCleanup() {
    if (activeRun) return activeRun;
    activeRun = executeCleanup({ dryRun: false, confirmed: true })
      .catch(error => {
        console.error('Safe Drive cleanup failed:', error);
        window.showNotification?.(error?.message || 'מחיקת קובצי Drive נכשלה.', false);
        return { ok: false, failures: [{ message: error?.message || String(error) }] };
      })
      .finally(() => {
        activeRun = null;
        setButtonState();
      });
    return activeRun;
  }

  function findDriveSectionAnchor() {
    const progress = document.getElementById('driveSyncProgress');
    if (progress) return progress;

    const folderInput = document.getElementById('driveFolderInput');
    if (folderInput) return folderInput.closest('section, article, div') || folderInput;

    return null;
  }

  function ensureCleanupButton() {
    const existing = document.getElementById(BUTTON_ID);
    const shouldShow = Boolean(window.state?.isSuperAdmin);

    if (!shouldShow) {
      if (existing) existing.hidden = true;
      return;
    }

    const anchor = findDriveSectionAnchor();
    if (!anchor) return;

    let button = existing;
    if (!button) {
      button = document.createElement('button');
      button.id = BUTTON_ID;
      button.type = 'button';
      button.className = 'mt-3 w-full rounded-xl border border-red-500/35 bg-red-500/10 px-4 py-3 text-xs font-black text-red-200 transition hover:bg-red-500/20 disabled:opacity-60';
      button.setAttribute('aria-label', 'מחיקת קובצי Google Drive הישנים');
      button.addEventListener('click', handleOneClickCleanup);
      anchor.insertAdjacentElement('afterend', button);
    }

    button.hidden = false;
    if (!activeRun) {
      button.disabled = makePreview().imageCount === 0;
      button.textContent = getButtonLabel();
    }
  }

  function startUi() {
    ensureCleanupButton();
    if (uiObserver) return;

    uiObserver = new MutationObserver(() => ensureCleanupButton());
    uiObserver.observe(document.documentElement, { childList: true, subtree: true });

    window.addEventListener('safe-drive-cleanup-progress', ensureCleanupButton);
    setInterval(ensureCleanupButton, 2500);
  }

  window.previewSafeDriveCleanup = () => executeCleanup({ dryRun: true });
  window.runSafeDriveCleanup = options => {
    if (activeRun) return activeRun;
    activeRun = executeCleanup(options).finally(() => {
      activeRun = null;
      setButtonState();
    });
    return activeRun;
  };

  window.SAFE_DRIVE_CLEANUP = Object.freeze({
    version: VERSION,
    concurrency: DELETE_CONCURRENCY,
    automatic: false,
    oneClickButton: true,
    deletesManualUploads: false
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startUi, { once: true });
  } else {
    startUi();
  }
})();