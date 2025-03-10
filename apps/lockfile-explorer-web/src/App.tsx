// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import React, { useEffect } from 'react';
import styles from './App.scss';
import { readLockfile } from './parsing/readLockfile';
import { LockfileViewer } from './containers/LockfileViewer';
import { PackageJsonViewer } from './containers/PackageJsonViewer';
import { useAppDispatch } from './store/hooks';
import { loadEntries } from './store/slices/entrySlice';
import { LockfileEntryDetailsView } from './containers/LockfileEntryDetailsView';
import { BookmarksSidebar } from './containers/BookmarksSidebar';
import { SelectedEntryPreview } from './containers/SelectedEntryPreview';
import { LogoPanel } from './containers/LogoPanel';

/**
 * This React component renders the application page.
 */
export const App = (): JSX.Element => {
  const dispatch = useAppDispatch();

  useEffect(() => {
    async function loadLockfile(): Promise<void> {
      const lockfile = await readLockfile();
      dispatch(loadEntries(lockfile));
    }
    loadLockfile().catch((e) => {
      console.log(`Failed to read lockfile: ${e}`);
    });
  }, []);

  return (
    <div className={styles.AppContainer}>
      <div className={styles.AppGrid}>
        <div className="ms-Grid" dir="ltr">
          <div className="ms-Grid-row">
            <div className="ms-Grid-col ms-sm3">
              <LockfileViewer />
            </div>
            <div className={`ms-Grid-col ms-sm7 ${styles.BodyContainer}`}>
              <SelectedEntryPreview />
              <PackageJsonViewer />
              <LockfileEntryDetailsView />
            </div>
            <div className="ms-Grid-col ms-sm2">
              <BookmarksSidebar />
            </div>
          </div>
        </div>
      </div>
      <LogoPanel />
    </div>
  );
};
