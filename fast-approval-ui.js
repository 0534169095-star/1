(() => {
  'use strict';

  const VERSION = '2026-08-02-fast-approval-ui-1';
  const FAILURE_PATTERN = /(נכשל|נכשלה|שגיאה|לא ניתן|בדוק את הרשאות)/i;
  let installTimer = null;

  const safeId = value => String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120);

  function isFailureNotification(message, success) {
    return success === false || FAILURE_PATTERN.test(String(message || ''));
  }

  function refreshUserApprovals() {
    window.renderPendingUsers?.();
    window.updatePendingUsersBadge?.();
    window.renderManagedUsers?.();
    window.updateAdminOverview?.();
  }

  function refreshPendingImages() {
    window.renderPendingImages?.();
    window.updatePendingBadge?.();
    window.updateAdminOverview?.();
  }

  function refreshDeletionRequests() {
    window.renderDeletionRequests?.();
    window.updateAdminOverview?.();
  }

  async function runOptimisticAction(startAction, onOptimistic, onSuccess, onFailure) {
    const originalNotification = window.showNotification;
    let failed = false;

    const notificationProxy = function(message, success, ...rest) {
      if (isFailureNotification(message, success)) failed = true;
      if (typeof originalNotification === 'function') {
        return originalNotification.call(window, message, success, ...rest);
      }
    };

    if (typeof originalNotification === 'function') {
      window.showNotification = notificationProxy;
    }

    try {
      // מפעילים קודם את הפעולה המקורית. היא מספיקה לשמור את הנתונים המקומיים
      // הדרושים לה לפני שה־Promise חוזר, ורק אז מעדכנים את המסך מיד.
      const resultPromise = startAction();
      onOptimistic?.();
      const result = await resultPromise;

      if (failed) onFailure?.();
      else onSuccess?.();
      return result;
    } catch (error) {
      failed = true;
      onFailure?.();
      throw error;
    } finally {
      if (window.showNotification === notificationProxy) {
        window.showNotification = originalNotification;
      }
    }
  }

  function patchUserApproval() {
    const original = window.approveUserAccess;
    if (typeof original !== 'function' || original.__fastApprovalUiWrapped) return false;

    const wrapped = async function(uid, role, confirmed = false) {
      if (!confirmed) return original.apply(this, arguments);

      const id = safeId(uid);
      const users = window.state?.pendingUsers || [];
      const index = users.findIndex(profile => safeId(profile?.uid) === id);
      const profile = index >= 0 ? users[index] : null;
      if (!profile) return original.apply(this, arguments);

      return runOptimisticAction(
        () => original.apply(this, arguments),
        () => {
          window.state.pendingUsers = users.filter(item => safeId(item?.uid) !== id);
          refreshUserApprovals();
        },
        () => refreshUserApprovals(),
        () => {
          const current = window.state.pendingUsers || [];
          if (!current.some(item => safeId(item?.uid) === id)) {
            const restored = [...current];
            restored.splice(Math.min(index, restored.length), 0, profile);
            window.state.pendingUsers = restored;
          }
          refreshUserApprovals();
        }
      );
    };

    wrapped.__fastApprovalUiWrapped = true;
    wrapped.__fastApprovalUiOriginal = original;
    window.approveUserAccess = wrapped;
    return true;
  }

  function patchDeletionRequestApproval() {
    const original = window.resolveDeletionRequest;
    if (typeof original !== 'function' || original.__fastApprovalUiWrapped) return false;

    const wrapped = async function(requestId, approved) {
      const id = safeId(requestId);
      const requests = window.state?.deletionRequests || [];
      const index = requests.findIndex(request => safeId(request?.id) === id);
      const request = index >= 0 ? requests[index] : null;
      if (!request) return original.apply(this, arguments);

      return runOptimisticAction(
        () => original.apply(this, arguments),
        () => {
          window.state.deletionRequests = requests.filter(item => safeId(item?.id) !== id);
          refreshDeletionRequests();
        },
        () => refreshDeletionRequests(),
        () => {
          const current = window.state.deletionRequests || [];
          if (!current.some(item => safeId(item?.id) === id)) {
            const restored = [...current];
            restored.splice(Math.min(index, restored.length), 0, request);
            window.state.deletionRequests = restored;
          }
          refreshDeletionRequests();
        }
      );
    };

    wrapped.__fastApprovalUiWrapped = true;
    wrapped.__fastApprovalUiOriginal = original;
    window.resolveDeletionRequest = wrapped;
    return true;
  }

  function patchPendingImageApproval() {
    const original = window.approveConfirmAction;
    if (typeof original !== 'function' || original.__fastApprovalUiWrapped) return false;

    const wrapped = async function() {
      const title = document.getElementById('confirmTitle')?.textContent || '';
      if (!title.includes('אישור תמונות')) {
        return original.apply(this, arguments);
      }

      const selectedInputs = [...document.querySelectorAll('input[name="pendingImgCheck"]:checked')];
      const selectedIds = selectedInputs.map(input => safeId(input.value)).filter(Boolean);
      if (selectedIds.length === 0) return original.apply(this, arguments);

      const selectedIdSet = new Set(selectedIds);
      const cards = selectedInputs
        .map(input => input.closest('label'))
        .filter(Boolean);

      return runOptimisticAction(
        () => original.apply(this, arguments),
        () => {
          for (const card of cards) {
            card.dataset.fastApprovalHidden = 'true';
            card.style.display = 'none';
          }
          const badge = document.getElementById('pendingCountBadge');
          if (badge) {
            const remaining = Math.max(0, (window.state?.pendingImages || []).length - selectedIds.length);
            badge.textContent = String(remaining);
          }
        },
        () => {
          window.state.pendingImages = (window.state.pendingImages || [])
            .filter(image => !selectedIdSet.has(safeId(image?.id)));
          refreshPendingImages();
        },
        () => {
          for (const card of cards) {
            card.style.display = '';
            delete card.dataset.fastApprovalHidden;
          }
          refreshPendingImages();
        }
      );
    };

    wrapped.__fastApprovalUiWrapped = true;
    wrapped.__fastApprovalUiOriginal = original;
    window.approveConfirmAction = wrapped;
    return true;
  }

  function installPatches() {
    const userReady = patchUserApproval() || Boolean(window.approveUserAccess?.__fastApprovalUiWrapped);
    const imageReady = patchPendingImageApproval() || Boolean(window.approveConfirmAction?.__fastApprovalUiWrapped);
    const deletionReady = patchDeletionRequestApproval() || Boolean(window.resolveDeletionRequest?.__fastApprovalUiWrapped);

    if (userReady && imageReady && deletionReady && installTimer) {
      clearInterval(installTimer);
      installTimer = null;
    }
  }

  installPatches();
  installTimer = setInterval(installPatches, 400);

  window.FAST_APPROVAL_UI = Object.freeze({
    version: VERSION,
    optimistic: true,
    restoresOnFailure: true,
    changesServerLogic: false
  });
})();
