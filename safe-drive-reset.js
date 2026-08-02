(() => {
  'use strict';

  const VERSION = '2026-08-02-safe-preview-1';
  const CONFIRMATION_PHRASE = 'מחק קבצי DRIVE';
  const DELETE_CONCURRENCY = 2;
  let activeRun = null;

  const safeId = value => String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120);

  function assertReady() {
    if (!window.state?.isSuperAdmin) {
      throw new Error('הפעולה זמינה רק למנהל־על.');
    }
    if (!window.db || !window.firestoreModules?.doc || !window.firestoreModules?.deleteDoc) {
      throw new Error('החיבור למסד הנתונים עדיין לא מוכן.');
    }
    if (typeof window.deleteImageFromR2 !== 'function') {
      throw new Error('מנגנון מחיקת הקבצים מ־R2 עדיין לא מוכן.');
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
      requiresPhrase: CONFIRMATION_PHRASE
    });
  }

  function emitProgress(detail) {
    window.dispatchEvent(new CustomEvent('safe-drive-cleanup-progress', { detail }));
    console.info('[Safe Drive cleanup]', detail);
  }

  async function runPool(items, worker, concurrency = DELETE_CONCURRENCY) {
    let cursor = 0;
    const completed = [];
    const failed = [];

    async function runner() {
      while (cursor < items.length) {
        const index = cursor++;
        const item = items[index];
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
      }
    }

    const runners = Math.max(1, Math.min(concurrency, items.length || 1));
    await Promise.all(Array.from({ length: runners }, runner));
    return { completed, failed };
  }

  async function deleteDriveImage(image) {
    const imageId = safeId(image?.id);
    if (!imageId) throw new Error('מזהה תמונה לא תקין.');

    await window.deleteImageFromR2(image);

    const { doc, deleteDoc } = window.firestoreModules;
    await deleteDoc(doc(
      window.db,
      'artifacts',
      window.appId,
      'public',
      'data',
      'images',
      imageId
    ));
  }

  async function deleteDriveFolder(folder) {
    const folderId = safeId(folder?.id);
    if (!folderId) throw new Error('מזהה תיקייה לא תקין.');

    const { doc, deleteDoc } = window.firestoreModules;
    await deleteDoc(doc(
      window.db,
      'artifacts',
      window.appId,
      'public',
      'data',
      'folders',
      folderId
    ));
  }

  async function executeCleanup(options = {}) {
    assertReady();

    const preview = makePreview();
    const dryRun = options.dryRun !== false;

    if (dryRun) {
      emitProgress({ phase: 'preview', ...preview });
      return { ok: true, dryRun: true, preview };
    }

    if (options.confirmationText !== CONFIRMATION_PHRASE) {
      throw new Error(`כדי לבצע מחיקה יש להקליד בדיוק: ${CONFIRMATION_PHRASE}`);
    }

    if (preview.imageCount === 0 && preview.folderCount === 0) {
      return { ok: true, dryRun: false, deletedImages: 0, deletedFolders: 0, failures: [] };
    }

    const { images, folders } = collectCandidates();
    emitProgress({ phase: 'starting', imageCount: images.length, folderCount: folders.length });

    const imageResult = await runPool(images, deleteDriveImage);

    if (imageResult.failed.length > 0) {
      const succeededIds = new Set(imageResult.completed.map(image => safeId(image.id)));
      window.state.images = (window.state.images || []).filter(image => !succeededIds.has(safeId(image?.id)));
      window.renderImages?.();
      window.renderGallery?.();

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
        `המחיקה נעצרה בבטחה: ${result.failures.length} קבצים לא נמחקו. הסנכרון לא התחיל.`,
        false
      );
      return result;
    }

    const folderResult = await runPool(folders, deleteDriveFolder, 1);
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
      window.showNotification?.('התמונות נמחקו, אך חלק מרשומות התיקיות לא נמחקו.', false);
      return result;
    }

    const deletedImageIds = new Set(imageResult.completed.map(image => safeId(image.id)));
    const deletedFolderIds = new Set(folderResult.completed.map(folder => safeId(folder.id)));
    window.state.images = (window.state.images || []).filter(image => !deletedImageIds.has(safeId(image?.id)));
    window.state.folders = (window.state.folders || []).filter(folder => !deletedFolderIds.has(safeId(folder?.id)));
    window.state.activeFolderId = 'all';
    window.renderImages?.();
    window.renderGallery?.();
    window.renderFolders?.();
    window.populateFolderSelects?.();

    const result = {
      ok: true,
      dryRun: false,
      deletedImages: imageResult.completed.length,
      deletedFolders: folderResult.completed.length,
      failures: []
    };
    emitProgress({ phase: 'complete', ...result });
    window.showNotification?.(
      `המחיקה הבטוחה הסתיימה: ${result.deletedImages} קובצי Drive נמחקו.`,
      true
    );
    return result;
  }

  window.previewSafeDriveCleanup = () => executeCleanup({ dryRun: true });
  window.runSafeDriveCleanup = options => {
    if (activeRun) return activeRun;
    activeRun = executeCleanup(options).finally(() => {
      activeRun = null;
    });
    return activeRun;
  };
  window.SAFE_DRIVE_CLEANUP = Object.freeze({
    version: VERSION,
    confirmationPhrase: CONFIRMATION_PHRASE,
    concurrency: DELETE_CONCURRENCY,
    automatic: false,
    deletesManualUploads: false
  });
})();
