import { defineCommand } from 'citty'

export const restoreCommand = defineCommand({
  meta: {
    name: 'restore',
    description: 'Restore a Porteau backup artifact',
  },
  args: {
    config: {
      type: 'string',
      alias: 'c',
      description: 'Path to a YAML configuration file',
    },
    artifact: {
      type: 'string',
      alias: 'a',
      description: 'Backup artifact directory',
    },
    user: { type: 'string', description: 'Destination database user' },
    'source-database': {
      type: 'string',
      description: 'Database name stored in the artifact',
    },
    'destination-database': {
      type: 'string',
      description: 'Destination database name',
    },
    'destination-policy': {
      type: 'string',
      description: 'Destination policy: require-empty or allow-existing',
    },
    'overwrite-policy': {
      type: 'string',
      description: 'Existing table policy: reject, drop, truncate, or delete',
    },
    'binlog-policy': {
      type: 'string',
      description: 'Destination binlog policy: disable or enable',
    },
  },
})
