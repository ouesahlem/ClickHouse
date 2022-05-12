import { createBuffer } from '@posthog/plugin-contrib'
import { Plugin, PluginMeta, PluginEvent } from '@posthog/plugin-scaffold'
import { Client } from 'pg'

type ClickHousePlugin = Plugin<{
    global: {
        pgClient: Client
        eventsToInsert: Set<string>
        sanitizedTableName: string
    }
    config: {
        databaseUrl: string
        host: string
        port: string
        dbName: string
        tableName: string
        dbUsername: string
        dbPassword: string
        eventsToInsert: string
        hasSelfSignedCert: 'Yes' | 'No'
    }
}>
    
type ClickHouseMeta = PluginMeta<ClickHousePlugin>
    
interface ParsedEvent {
    feedback_type: string
    user_id: string
    item_id: string
    time_stamp: string
    comment: string
}

interface UploadJobPayload {
    batch: ParsedEvent[]
    batchId: number
    retriesPerformedSoFar: number
}

const randomBytes = (): string => {
    return (((1 + Math.random()) * 0x10000) | 0).toString(16).substring(1)
}

export const jobs: ClickHousePlugin['jobs'] = {
    uploadBatchToClickHouse: async (payload: UploadJobPayload, meta: ClickHouseMeta) => {
        await insertBatchIntoClickHouse(payload, meta)
    },
}

export const setupPlugin: ClickHousePlugin['setupPlugin'] = async (meta) => {
    const { global, config } = meta

    if (!config.databaseUrl) {
        const requiredConfigOptions = ['host', 'port', 'dbName', 'dbUsername', 'dbPassword']
        for (const option of requiredConfigOptions) {
            if (!(option in config)) {
                throw new Error(`Required config option ${option} is missing!`)
            }
        }
    }

    global.sanitizedTableName = sanitizeSqlIdentifier(config.tableName)

    const queryError = await executeQuery(
        `CREATE TABLE IF NOT EXISTS public.${global.sanitizedTableName} (
            feedback_type varchar(200),
            user_id varchar(200),
            item_id varchar(200),
            time_stamp timestamp with time zone,
            comment varchar(200)
        );`,
        [],
        config
    )

    if (queryError) {
        throw new Error(`Unable to connect to ClickHouse instance and create table with error: ${queryError.message}`)
    }

    global.eventsToInsert = new Set(
        config.eventsToInsert ? config.eventsToInsert.split(',').map((event) => event.trim()) : null
    )
}

export async function exportEvents(events: PluginEvent[], { global, jobs }: ClickHouseMeta) {
    const batch: ParsedEvent[] = []
    for (const event of events) {
        const {
            event: eventName,
            properties,
            anonymousId,
            service_id,
            timestamp,
            elements_chain,
            now,
            sent_at,
            ..._discard
        } = event

        if (!global.eventsToInsert.has(eventName)) {
            continue
        }

        const parsedEvent: ParsedEvent = {
            eventName,
            anonymousId: JSON.stringify(anonymousId || {}),
            service_id: JSON.stringify(service_id || {}),
            timestamp: new Date(timestamp).toISOString(),
            elements_chain: JSON.stringify(elements_chain || {})
        }

        batch.push(parsedEvent)
    }

    if (batch.length > 0) {
        await jobs
            .uploadBatchToClickHouse({ batch, batchId: Math.floor(Math.random() * 1000000), retriesPerformedSoFar: 0 })
            .runNow()
    }
}

export const insertBatchIntoClickHouse = async (payload: UploadJobPayload, { global, jobs, config }: ClickHouseMeta) => {
    let values: any[] = []
    let valuesString = ''

    for (let i = 0; i < payload.batch.length; ++i) {
        const { eventName, anonymousId, service_id, timestamp, elements_chain } =
            payload.batch[i]


        // Creates format: ($1, $2, $3, $4, $5), ($12, $13, $14, $15, $16)
        valuesString += ' ('
        for (let j = 1; j <= 5; ++j) {
            valuesString += `$${5 * i + j}${j === 5 ? '' : ', '}`
        }
        valuesString += `)${i === payload.batch.length - 1 ? '' : ','}`
        
        values = values.concat([
            eventName,
            anonymousId,
            service_id,
            timestamp,
            elements_chain
        ])
    }

    console.log(
        `(Batch Id: ${payload.batchId}) Flushing ${payload.batch.length} event${
            payload.batch.length > 1 ? 's' : ''
        } to clickhouse instance`
    )

    const queryError = await executeQuery(
        `INSERT INTO ${global.sanitizedTableName} (feedback_type, user_id, item_id, time_stamp, comment)
        VALUES ${valuesString}`,
        values,
        config
    )

    if (queryError) {
        console.error(`(Batch Id: ${payload.batchId}) Error uploading to ClickHouse: ${queryError.message}`)
        if (payload.retriesPerformedSoFar >= 15) {
            return
        }
        const nextRetryMs = 2 ** payload.retriesPerformedSoFar * 3000
        console.log(`Enqueued batch ${payload.batchId} for retry in ${nextRetryMs}ms`)
        await jobs
            .uploadBatchToClickHouse({
                ...payload,
                retriesPerformedSoFar: payload.retriesPerformedSoFar + 1,
            })
            .runIn(nextRetryMs, 'milliseconds')
    }
}

const executeQuery = async (query: string, values: any[], config: ClickHouseMeta['config']): Promise<Error | null> => {
    const basicConnectionOptions = config.databaseUrl
        ? {
              connectionString: config.databaseUrl,
          }
        : {
              user: config.dbUsername,
              password: config.dbPassword,
              host: config.host,
              database: config.dbName,
              port: parseInt(config.port),
          }
    const pgClient = new Client({
        ...basicConnectionOptions,
        ssl: {
            rejectUnauthorized: config.hasSelfSignedCert === 'No',
        },
    })

    await pgClient.connect()

    let error: Error | null = null
    try {
        await pgClient.query(query, values)
    } catch (err) {
        error = err as Error
    }

    await pgClient.end()

    return error
}

const sanitizeSqlIdentifier = (unquotedIdentifier: string): string => {
    return unquotedIdentifier.replace(/[^\w\d_]+/g, '')
}
