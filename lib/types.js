/**
 * @typedef {'pending'|'proposed'|'accepted'|'edited'|'skipped'|'deleted'|'error'} BlockStatus
 *
 * @typedef {Object} BlockRow
 * @property {string} row_id
 * @property {string} story_id
 * @property {string} story_full_slug
 * @property {string} story_name
 * @property {string} locale
 * @property {string} block_uid
 * @property {string} block_path
 * @property {string} block_component
 * @property {string[]} affected_fields
 * @property {Object<string,string>} original_payload
 * @property {string} llm_match_reason
 * @property {Object<string,string>|null} proposed_payload
 * @property {Object<string,string>|null} edited_payload
 * @property {BlockStatus} status
 * @property {{category:string, comment:string}|null} skip_reason
 *
 * @typedef {Object} Campaign
 * @property {string} id
 * @property {string} topic
 * @property {string} started_at
 * @property {string} source_locale
 * @property {string} rewrite_prompt
 *
 * @typedef {Object} CampaignState
 * @property {Campaign} campaign
 * @property {Object} progress
 * @property {number} progress.total
 * @property {number} progress.reviewed
 * @property {Object<BlockStatus,number>} progress.by_status
 * @property {BlockRow[]} blocks
 *
 * @typedef {'accept'|'edit'|'skip'|'delete'} ActionType
 *
 * @typedef {Object} ActionPayload
 * @property {string} campaign_id
 * @property {string} row_id
 * @property {ActionType} action
 * @property {Object<string,string>} [edited_payload]
 * @property {{category:string, comment:string}} [skip_reason]
 */

export {};
