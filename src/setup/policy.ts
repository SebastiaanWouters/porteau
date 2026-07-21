import { compatibilityManifest } from './manifest.js'

export const minimumNodeVersion = '22.18.0'
export const nodeTargetMajor = 24
export const nodeSourceKeyUrl = 'https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key'
export const nodeSourceFingerprint = '6F71F525282841EEDAF851B42F59B5F99B1BE0B4'
export const nodeSourceKeyring = '/usr/share/keyrings/porteau-nodesource.gpg'
export const nodeSourceList = '/etc/apt/sources.list.d/porteau-nodesource.list'
export const nodeSourceRepository = `deb [signed-by=${nodeSourceKeyring}] https://deb.nodesource.com/node_${nodeTargetMajor}.x nodistro main`

export const supportedTargetDescription = compatibilityManifest.assets
  .map(({ ubuntu, architecture }) => `Ubuntu ${ubuntu} ${architecture}`)
  .join('; ')
