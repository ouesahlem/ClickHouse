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
    
interface ParsedFeedback {
    feedback_type: string
    user_id: string
    item_id: string
    time_stamp: string
    comment: string
}

interface UploadJobPayload {
    batch: ParsedFeedback[]
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

        const ip = properties?.['$ip'] || event.ip
        const timestamp = event.timestamp || properties?.timestamp || now || sent_at
        let ingestedProperties = properties
        let elements = []

        const parsedEvent: ParsedEvent = {
            eventName,
            properties: JSON.stringify(ingestedProperties || {}),
            elements: JSON.stringify(elements || {}),
            set: JSON.stringify($set || {}),
            set_once: JSON.stringify($set_once || {}),
            timestamp: new Date(timestamp).toISOString(),
        }

        batch.push(parsedEvent)
    }

    if (batch.length > 0) {
        await jobs
            .uploadBatchToPostgres({ batch, batchId: Math.floor(Math.random() * 1000000), retriesPerformedSoFar: 0 })
            .runNow()
    }
}
