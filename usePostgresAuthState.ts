import { BufferJSON, initAuthCreds, proto, SignalDataTypeMap } from '@whiskeysockets/baileys';
import { Pool } from 'pg';

export const usePostgresAuthState = async (pool: Pool) => {
    // Create table if not exists
    await pool.query(`
        CREATE TABLE IF NOT EXISTS baileys_sessions (
            id VARCHAR(255) PRIMARY KEY,
            data JSONB NOT NULL
        );
    `);

    const readData = async (id: string) => {
        const res = await pool.query('SELECT data FROM baileys_sessions WHERE id = $1', [id]);
        if (res.rows.length > 0) {
            return JSON.parse(JSON.stringify(res.rows[0].data), BufferJSON.reviver);
        }
        return null;
    };

    const writeData = async (id: string, data: any) => {
        const str = JSON.stringify(data, BufferJSON.replacer);
        await pool.query(
            'INSERT INTO baileys_sessions (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data',
            [id, str]
        );
    };

    const removeData = async (id: string) => {
        await pool.query('DELETE FROM baileys_sessions WHERE id = $1', [id]);
    };

    const creds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type: string, ids: string[]) => {
                    const data: { [key: string]: any } = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data: any) => {
                    const tasks: Promise<any>[] = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) {
                                tasks.push(writeData(key, value));
                            } else {
                                tasks.push(removeData(key));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => {
            return writeData('creds', creds);
        }
    };
};
