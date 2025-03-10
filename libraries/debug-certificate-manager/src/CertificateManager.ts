// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type { pki } from 'node-forge';
import * as path from 'path';
import { EOL } from 'os';
import { FileSystem, ITerminal } from '@rushstack/node-core-library';

import { runSudoAsync, IRunResult, runAsync } from './runCommand';
import { CertificateStore } from './CertificateStore';

const CA_SERIAL_NUMBER: string = '731c321744e34650a202e3ef91c3c1b0';
const TLS_SERIAL_NUMBER: string = '731c321744e34650a202e3ef00000001';
const FRIENDLY_NAME: string = 'debug-certificate-manager Development Certificate';
const MAC_KEYCHAIN: string = '/Library/Keychains/System.keychain';
const CERTUTIL_EXE_NAME: string = 'certutil';
const CA_ALT_NAME: string = 'rushstack-certificate-manager.localhost';

/**
 * The set of names the certificate should be generated for, by default.
 * @public
 */
export const DEFAULT_CERTIFICATE_SUBJECT_NAMES: ReadonlyArray<string> = ['localhost'];

/**
 * The interface for a debug certificate instance
 *
 * @public
 */
export interface ICertificate {
  /**
   * Generated pem Certificate Authority certificate contents
   */
  pemCaCertificate: string | undefined;

  /**
   * Generated pem TLS Server certificate contents
   */
  pemCertificate: string | undefined;

  /**
   * Private key for the TLS server certificate, used to sign TLS communications
   */
  pemKey: string | undefined;

  /**
   * The subject names the TLS server certificate is valid for
   */
  subjectAltNames: readonly string[] | undefined;
}

interface ICaCertificate {
  /**
   * Certificate
   */
  certificate: pki.Certificate;

  /**
   * Private key for the CA cert. Delete after signing the TLS cert.
   */
  privateKey: pki.PrivateKey;
}

interface ISubjectAltNameExtension {
  altNames: readonly IAltName[];
}

interface IAltName {
  type: 2;
  value: string;
}

/**
 * Options to use if needing to generate a new certificate
 * @public
 */
export interface ICertificateGenerationOptions {
  /**
   * The DNS Subject names to issue the certificate for.
   */
  subjectAltNames?: ReadonlyArray<string>;
  /**
   * How many days the certificate should be valid for.
   */
  validityInDays?: number;
}

/**
 * A utility class to handle generating, trusting, and untrustring a debug certificate.
 * Contains two public methods to `ensureCertificate` and `untrustCertificate`.
 * @public
 */
export class CertificateManager {
  private _certificateStore: CertificateStore;

  public constructor() {
    this._certificateStore = new CertificateStore();
  }

  /**
   * Get a development certificate from the store, or optionally, generate a new one
   * and trust it if one doesn't exist in the store.
   *
   * @public
   */
  public async ensureCertificateAsync(
    canGenerateNewCertificate: boolean,
    terminal: ITerminal,
    generationOptions?: ICertificateGenerationOptions
  ): Promise<ICertificate> {
    const optionsWithDefaults: Required<ICertificateGenerationOptions> =
      applyDefaultOptions(generationOptions);

    if (this._certificateStore.certificateData && this._certificateStore.keyData) {
      const messages: string[] = [];

      const altNamesExtension: ISubjectAltNameExtension | undefined =
        await this._getCertificateSubjectAltNameAsync();
      if (!altNamesExtension) {
        messages.push(
          'The existing development certificate is missing the subjectAltName ' +
            'property and will not work with the latest versions of some browsers.'
        );
      }

      const hasCA: boolean = !!this._certificateStore.caCertificateData;
      if (!hasCA) {
        messages.push(
          'The existing development certificate is missing a separate CA cert as the root ' +
            'of trust and will not work with the latest versions of some browsers.'
        );
      }

      const isTrusted: boolean = await this._detectIfCertificateIsTrustedAsync(terminal);
      if (!isTrusted) {
        messages.push('The existing development certificate is not currently trusted by your system.');
      }

      if (!altNamesExtension || !isTrusted || !hasCA) {
        if (canGenerateNewCertificate) {
          messages.push('Attempting to untrust the certificate and generate a new one.');
          terminal.writeWarningLine(messages.join(' '));
          await this.untrustCertificateAsync(terminal);
          return await this._ensureCertificateInternalAsync(optionsWithDefaults, terminal);
        } else {
          messages.push(
            'Untrust the certificate and generate a new one, or set the ' +
              '`canGenerateNewCertificate` parameter to `true` when calling `ensureCertificateAsync`.'
          );
          throw new Error(messages.join(' '));
        }
      } else {
        return {
          pemCaCertificate: this._certificateStore.caCertificateData,
          pemCertificate: this._certificateStore.certificateData,
          pemKey: this._certificateStore.keyData,
          subjectAltNames: altNamesExtension.altNames.map((entry) => entry.value)
        };
      }
    } else if (canGenerateNewCertificate) {
      return await this._ensureCertificateInternalAsync(optionsWithDefaults, terminal);
    } else {
      throw new Error(
        'No development certificate found. Generate a new certificate manually, or set the ' +
          '`canGenerateNewCertificate` parameter to `true` when calling `ensureCertificateAsync`.'
      );
    }
  }

  /**
   * Attempt to locate a previously generated debug certificate and untrust it.
   *
   * @public
   */
  public async untrustCertificateAsync(terminal: ITerminal): Promise<boolean> {
    this._certificateStore.certificateData = undefined;
    this._certificateStore.keyData = undefined;

    switch (process.platform) {
      case 'win32':
        const winUntrustResult: IRunResult = await runAsync(CERTUTIL_EXE_NAME, [
          '-user',
          '-delstore',
          'root',
          CA_SERIAL_NUMBER
        ]);

        if (winUntrustResult.code !== 0) {
          terminal.writeErrorLine(`Error: ${winUntrustResult.stderr.join(' ')}`);
          return false;
        } else {
          terminal.writeVerboseLine('Successfully untrusted development certificate.');
          return true;
        }

      case 'darwin':
        terminal.writeVerboseLine('Trying to find the signature of the development certificate.');

        const macFindCertificateResult: IRunResult = await runAsync('security', [
          'find-certificate',
          '-c',
          'localhost',
          '-a',
          '-Z',
          MAC_KEYCHAIN
        ]);
        if (macFindCertificateResult.code !== 0) {
          terminal.writeErrorLine(
            `Error finding the development certificate: ${macFindCertificateResult.stderr.join(' ')}`
          );
          return false;
        }

        const shaHash: string | undefined = this._parseMacOsMatchingCertificateHash(
          macFindCertificateResult.stdout.join(EOL)
        );

        if (!shaHash) {
          terminal.writeErrorLine('Unable to find the development certificate.');
          return false;
        } else {
          terminal.writeVerboseLine(`Found the development certificate. SHA is ${shaHash}`);
        }

        const macUntrustResult: IRunResult = await runSudoAsync('security', [
          'delete-certificate',
          '-Z',
          shaHash,
          MAC_KEYCHAIN
        ]);

        if (macUntrustResult.code === 0) {
          terminal.writeVerboseLine('Successfully untrusted development certificate.');
          return true;
        } else {
          terminal.writeErrorLine(macUntrustResult.stderr.join(' '));
          return false;
        }

      default:
        // Linux + others: Have the user manually untrust the cert
        terminal.writeLine(
          'Automatic certificate untrust is only implemented for debug-certificate-manager on Windows ' +
            'and macOS. To untrust the development certificate, remove this certificate from your trusted ' +
            `root certification authorities: "${this._certificateStore.certificatePath}". The ` +
            `certificate has serial number "${CA_SERIAL_NUMBER}".`
        );
        return false;
    }
  }

  private async _createCACertificateAsync(
    validityInDays: number,
    forge: typeof import('node-forge')
  ): Promise<ICaCertificate> {
    const keys: pki.KeyPair = forge.pki.rsa.generateKeyPair(2048);
    const certificate: pki.Certificate = forge.pki.createCertificate();
    certificate.publicKey = keys.publicKey;

    certificate.serialNumber = CA_SERIAL_NUMBER;

    const now: Date = new Date();
    certificate.validity.notBefore = now;
    certificate.validity.notAfter.setUTCDate(certificate.validity.notBefore.getUTCDate() + validityInDays);

    const attrs: pki.CertificateField[] = [
      {
        name: 'commonName',
        value: CA_ALT_NAME
      }
    ];

    certificate.setSubject(attrs);
    certificate.setIssuer(attrs);

    const altNames: readonly IAltName[] = [
      {
        type: 2, // DNS
        value: CA_ALT_NAME
      }
    ];

    certificate.setExtensions([
      {
        name: 'basicConstraints',
        cA: true,
        pathLenConstraint: 0,
        critical: true
      },
      {
        name: 'subjectAltName',
        altNames,
        critical: true
      },
      {
        name: 'issuerAltName',
        altNames,
        critical: false
      },
      {
        name: 'keyUsage',
        keyCertSign: true,
        critical: true
      },
      {
        name: 'extKeyUsage',
        serverAuth: true,
        critical: true
      },
      {
        name: 'friendlyName',
        value: FRIENDLY_NAME
      }
    ]);

    // self-sign certificate
    certificate.sign(keys.privateKey, forge.md.sha256.create());

    return {
      certificate,
      privateKey: keys.privateKey
    };
  }

  private async _createDevelopmentCertificateAsync(
    options: Required<ICertificateGenerationOptions>
  ): Promise<ICertificate> {
    const forge: typeof import('node-forge') = await import('node-forge');
    const keys: pki.KeyPair = forge.pki.rsa.generateKeyPair(2048);
    const certificate: pki.Certificate = forge.pki.createCertificate();

    certificate.publicKey = keys.publicKey;
    certificate.serialNumber = TLS_SERIAL_NUMBER;

    const { subjectAltNames: subjectNames, validityInDays } = options;

    const { certificate: caCertificate, privateKey: caPrivateKey } = await this._createCACertificateAsync(
      validityInDays,
      forge
    );

    const now: Date = new Date();
    certificate.validity.notBefore = now;
    certificate.validity.notAfter.setUTCDate(certificate.validity.notBefore.getUTCDate() + validityInDays);

    const subjectAttrs: pki.CertificateField[] = [
      {
        name: 'commonName',
        value: subjectNames[0]
      }
    ];
    const issuerAttrs: pki.CertificateField[] = caCertificate.subject.attributes;

    certificate.setSubject(subjectAttrs);
    certificate.setIssuer(issuerAttrs);

    const subjectAltNames: readonly IAltName[] = subjectNames.map((subjectName) => ({
      type: 2, // DNS
      value: subjectName
    }));

    const issuerAltNames: readonly IAltName[] = [
      {
        type: 2, // DNS
        value: CA_ALT_NAME
      }
    ];

    certificate.setExtensions([
      {
        name: 'basicConstraints',
        cA: false,
        critical: true
      },
      {
        name: 'subjectAltName',
        altNames: subjectAltNames,
        critical: true
      },
      {
        name: 'issuerAltName',
        altNames: issuerAltNames,
        critical: false
      },
      {
        name: 'keyUsage',
        digitalSignature: true,
        keyEncipherment: true,
        dataEncipherment: true,
        critical: true
      },
      {
        name: 'extKeyUsage',
        serverAuth: true,
        critical: true
      },
      {
        name: 'friendlyName',
        value: FRIENDLY_NAME
      }
    ]);

    // Sign certificate with CA
    certificate.sign(caPrivateKey, forge.md.sha256.create());

    // convert a Forge certificate to PEM
    const caPem: string = forge.pki.certificateToPem(caCertificate);
    const pem: string = forge.pki.certificateToPem(certificate);
    const pemKey: string = forge.pki.privateKeyToPem(keys.privateKey);

    return {
      pemCaCertificate: caPem,
      pemCertificate: pem,
      pemKey: pemKey,
      subjectAltNames: options.subjectAltNames
    };
  }

  private async _tryTrustCertificateAsync(certificatePath: string, terminal: ITerminal): Promise<boolean> {
    switch (process.platform) {
      case 'win32':
        terminal.writeLine(
          'Attempting to trust a development certificate. This self-signed certificate only points to rushstack.localhost ' +
            'and will be stored in your local user profile to be used by other instances of ' +
            'debug-certificate-manager. If you do not consent to trust this certificate, click "NO" in the dialog.'
        );

        const winTrustResult: IRunResult = await runAsync(CERTUTIL_EXE_NAME, [
          '-user',
          '-addstore',
          'root',
          certificatePath
        ]);

        if (winTrustResult.code !== 0) {
          terminal.writeErrorLine(`Error: ${winTrustResult.stdout.toString()}`);

          const errorLines: string[] = winTrustResult.stdout
            .toString()
            .split(EOL)
            .map((line: string) => line.trim());

          // Not sure if this is always the status code for "cancelled" - should confirm.
          if (
            winTrustResult.code === 2147943623 ||
            errorLines[errorLines.length - 1].indexOf('The operation was canceled by the user.') > 0
          ) {
            terminal.writeLine('Certificate trust cancelled.');
          } else {
            terminal.writeErrorLine('Certificate trust failed with an unknown error.');
          }

          return false;
        } else {
          terminal.writeVerboseLine('Successfully trusted development certificate.');

          return true;
        }

      case 'darwin':
        terminal.writeLine(
          'Attempting to trust a development certificate. This self-signed certificate only points to localhost ' +
            'and will be stored in your local user profile to be used by other instances of ' +
            'debug-certificate-manager. If you do not consent to trust this certificate, do not enter your ' +
            'root password in the prompt.'
        );

        const result: IRunResult = await runSudoAsync('security', [
          'add-trusted-cert',
          '-d',
          '-r',
          'trustRoot',
          '-k',
          MAC_KEYCHAIN,
          certificatePath
        ]);

        if (result.code === 0) {
          terminal.writeVerboseLine('Successfully trusted development certificate.');
          return true;
        } else {
          if (
            result.stderr.some(
              (value: string) => !!value.match(/The authorization was cancelled by the user\./)
            )
          ) {
            terminal.writeLine('Certificate trust cancelled.');
            return false;
          } else {
            terminal.writeErrorLine(
              `Certificate trust failed with an unknown error. Exit code: ${result.code}. ` +
                `Error: ${result.stderr.join(' ')}`
            );
            return false;
          }
        }

      default:
        // Linux + others: Have the user manually trust the cert if they want to
        terminal.writeLine(
          'Automatic certificate trust is only implemented for debug-certificate-manager on Windows ' +
            'and macOS. To trust the development certificate, add this certificate to your trusted root ' +
            `certification authorities: "${certificatePath}".`
        );
        return true;
    }
  }

  private async _detectIfCertificateIsTrustedAsync(terminal: ITerminal): Promise<boolean> {
    switch (process.platform) {
      case 'win32':
        const winVerifyStoreResult: IRunResult = await runAsync(CERTUTIL_EXE_NAME, [
          '-user',
          '-verifystore',
          'root',
          CA_SERIAL_NUMBER
        ]);

        if (winVerifyStoreResult.code !== 0) {
          terminal.writeVerboseLine(
            'The development certificate was not found in the store. CertUtil error: ',
            winVerifyStoreResult.stderr.join(' ')
          );
          return false;
        } else {
          terminal.writeVerboseLine(
            'The development certificate was found in the store. CertUtil output: ',
            winVerifyStoreResult.stdout.join(' ')
          );
          return true;
        }

      case 'darwin':
        terminal.writeVerboseLine('Trying to find the signature of the development certificate.');

        const macFindCertificateResult: IRunResult = await runAsync('security', [
          'find-certificate',
          '-c',
          'localhost',
          '-a',
          '-Z',
          MAC_KEYCHAIN
        ]);

        if (macFindCertificateResult.code !== 0) {
          terminal.writeVerboseLine(
            'The development certificate was not found in keychain. Find certificate error: ',
            macFindCertificateResult.stderr.join(' ')
          );
          return false;
        }

        const shaHash: string | undefined = this._parseMacOsMatchingCertificateHash(
          macFindCertificateResult.stdout.join(EOL)
        );

        if (!shaHash) {
          terminal.writeVerboseLine(
            'The development certificate was not found in keychain. Find certificate output:\n',
            macFindCertificateResult.stdout.join(' ')
          );
          return false;
        }

        terminal.writeVerboseLine(`The development certificate was found in keychain.`);
        return true;

      default:
        // Linux + others: Have the user manually verify the cert is trusted
        terminal.writeVerboseLine(
          'Automatic certificate trust validation is only implemented for debug-certificate-manager on Windows ' +
            'and macOS. Manually verify this development certificate is present in your trusted ' +
            `root certification authorities: "${this._certificateStore.certificatePath}". ` +
            `The certificate has serial number "${CA_SERIAL_NUMBER}".`
        );
        // Always return true on Linux to prevent breaking flow.
        return true;
    }
  }

  private async _trySetFriendlyNameAsync(certificatePath: string, terminal: ITerminal): Promise<boolean> {
    if (process.platform === 'win32') {
      const basePath: string = path.dirname(certificatePath);
      const fileName: string = path.basename(certificatePath, path.extname(certificatePath));
      const friendlyNamePath: string = path.join(basePath, `${fileName}.inf`);

      const friendlyNameFile: string = [
        '[Version]',
        'Signature = "$Windows NT$"',
        '[Properties]',
        `11 = "{text}${FRIENDLY_NAME}"`,
        ''
      ].join(EOL);

      await FileSystem.writeFileAsync(friendlyNamePath, friendlyNameFile);

      const repairStoreResult: IRunResult = await runAsync(CERTUTIL_EXE_NAME, [
        '-repairstore',
        '-user',
        'root',
        CA_SERIAL_NUMBER,
        friendlyNamePath
      ]);

      if (repairStoreResult.code !== 0) {
        terminal.writeErrorLine(`CertUtil Error: ${repairStoreResult.stderr.join('')}`);
        return false;
      } else {
        terminal.writeVerboseLine('Successfully set certificate name.');
        return true;
      }
    } else {
      // No equivalent concept outside of Windows
      return true;
    }
  }

  private async _ensureCertificateInternalAsync(
    options: Required<ICertificateGenerationOptions>,
    terminal: ITerminal
  ): Promise<ICertificate> {
    const certificateStore: CertificateStore = this._certificateStore;
    const generatedCertificate: ICertificate = await this._createDevelopmentCertificateAsync(options);

    const certificateName: string = Date.now().toString();
    const tempDirName: string = path.join(__dirname, '..', 'temp');

    const tempCertificatePath: string = path.join(tempDirName, `${certificateName}.pem`);
    const pemFileContents: string | undefined = generatedCertificate.pemCaCertificate;
    if (pemFileContents) {
      await FileSystem.writeFileAsync(tempCertificatePath, pemFileContents, {
        ensureFolderExists: true
      });
    }

    const trustCertificateResult: boolean = await this._tryTrustCertificateAsync(
      tempCertificatePath,
      terminal
    );

    let subjectAltNames: readonly string[] | undefined;
    if (trustCertificateResult) {
      certificateStore.caCertificateData = generatedCertificate.pemCaCertificate;
      certificateStore.certificateData = generatedCertificate.pemCertificate;
      certificateStore.keyData = generatedCertificate.pemKey;
      subjectAltNames = generatedCertificate.subjectAltNames;

      // Try to set the friendly name, and warn if we can't
      if (!this._trySetFriendlyNameAsync(tempCertificatePath, terminal)) {
        terminal.writeWarningLine("Unable to set the certificate's friendly name.");
      }
    } else {
      // Clear out the existing store data, if any exists
      certificateStore.caCertificateData = undefined;
      certificateStore.certificateData = undefined;
      certificateStore.keyData = undefined;
    }

    await FileSystem.deleteFileAsync(tempCertificatePath);

    return {
      pemCaCertificate: certificateStore.caCertificateData,
      pemCertificate: certificateStore.certificateData,
      pemKey: certificateStore.keyData,
      subjectAltNames
    };
  }

  private async _getCertificateSubjectAltNameAsync(): Promise<ISubjectAltNameExtension | undefined> {
    const certificateData: string | undefined = this._certificateStore.certificateData;
    if (!certificateData) {
      return;
    }
    const forge: typeof import('node-forge') = await import('node-forge');
    const certificate: pki.Certificate = forge.pki.certificateFromPem(certificateData);
    return certificate.getExtension('subjectAltName') as ISubjectAltNameExtension;
  }

  private _parseMacOsMatchingCertificateHash(findCertificateOuput: string): string | undefined {
    let shaHash: string | undefined = undefined;
    for (const line of findCertificateOuput.split(EOL)) {
      // Sets `shaHash` to the current certificate SHA-1 as we progress through the lines of certificate text.
      const shaHashMatch: string[] | null = line.match(/^SHA-1 hash: (.+)$/);
      if (shaHashMatch) {
        shaHash = shaHashMatch[1];
      }

      const snbrMatch: string[] | null = line.match(/^\s*"snbr"<blob>=0x([^\s]+).+$/);
      if (snbrMatch && (snbrMatch[1] || '').toLowerCase() === CA_SERIAL_NUMBER) {
        return shaHash;
      }
    }
  }
}

function applyDefaultOptions(
  options: ICertificateGenerationOptions | undefined
): Required<ICertificateGenerationOptions> {
  const subjectNames: ReadonlyArray<string> | undefined = options?.subjectAltNames;
  return {
    subjectAltNames: subjectNames?.length ? subjectNames : DEFAULT_CERTIFICATE_SUBJECT_NAMES,
    validityInDays: options?.validityInDays ?? 365 * 3
  };
}
