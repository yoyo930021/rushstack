// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

// Used to log diagnostics that may be useful when troubleshooting
// problems with the algorithm.
// TODO: Only print these messages in a production release
export const logDiagnosticInfo = (...args: string[]): void => {
  console.log('Diagnostic: ', ...args);
};
