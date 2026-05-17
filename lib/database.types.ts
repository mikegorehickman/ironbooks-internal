export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      audit_log: {
        Row: {
          action_id: string | null
          api_endpoint: string | null
          duration_ms: number | null
          error_message: string | null
          event_type: string
          http_method: string | null
          id: string
          job_id: string | null
          occurred_at: string | null
          request_payload: Json | null
          response_payload: Json | null
          status_code: number | null
          user_id: string | null
        }
        Insert: {
          action_id?: string | null
          api_endpoint?: string | null
          duration_ms?: number | null
          error_message?: string | null
          event_type: string
          http_method?: string | null
          id?: string
          job_id?: string | null
          occurred_at?: string | null
          request_payload?: Json | null
          response_payload?: Json | null
          status_code?: number | null
          user_id?: string | null
        }
        Update: {
          action_id?: string | null
          api_endpoint?: string | null
          duration_ms?: number | null
          error_message?: string | null
          event_type?: string
          http_method?: string | null
          id?: string
          job_id?: string | null
          occurred_at?: string | null
          request_payload?: Json | null
          response_payload?: Json | null
          status_code?: number | null
          user_id?: string | null
        }
        Relationships: []
      }
      bank_rules: {
        Row: {
          ai_confidence: number | null
          ai_reasoning: string | null
          client_link_id: string
          created_at: string | null
          created_by: string | null
          discovery_job_id: string | null
          id: string
          match_type: string | null
          max_amount: number | null
          min_amount: number | null
          pushed_to_qbo: boolean | null
          qbo_rule_id: string | null
          requires_approval: boolean | null
          sample_descriptions: string[] | null
          status: string | null
          target_account_name: string
          target_qbo_account_id: string | null
          tax_code_ref: string | null
          total_amount: number | null
          transaction_count: number | null
          updated_at: string | null
          vendor_pattern: string
        }
        Insert: {
          ai_confidence?: number | null
          ai_reasoning?: string | null
          client_link_id: string
          created_at?: string | null
          created_by?: string | null
          discovery_job_id?: string | null
          id?: string
          match_type?: string | null
          max_amount?: number | null
          min_amount?: number | null
          pushed_to_qbo?: boolean | null
          qbo_rule_id?: string | null
          requires_approval?: boolean | null
          sample_descriptions?: string[] | null
          status?: string | null
          target_account_name: string
          target_qbo_account_id?: string | null
          tax_code_ref?: string | null
          total_amount?: number | null
          transaction_count?: number | null
          updated_at?: string | null
          vendor_pattern: string
        }
        Update: {
          ai_confidence?: number | null
          ai_reasoning?: string | null
          client_link_id?: string
          created_at?: string | null
          created_by?: string | null
          discovery_job_id?: string | null
          id?: string
          match_type?: string | null
          max_amount?: number | null
          min_amount?: number | null
          pushed_to_qbo?: boolean | null
          qbo_rule_id?: string | null
          requires_approval?: boolean | null
          sample_descriptions?: string[] | null
          status?: string | null
          target_account_name?: string
          target_qbo_account_id?: string | null
          tax_code_ref?: string | null
          total_amount?: number | null
          transaction_count?: number | null
          updated_at?: string | null
          vendor_pattern?: string
        }
        Relationships: []
      }
      client_links: {
        Row: {
          assigned_bookkeeper_id: string | null
          client_email: string | null
          client_name: string
          created_at: string | null
          double_client_id: string
          double_client_name: string | null
          id: string
          industry: string | null
          is_active: boolean | null
          jurisdiction: Database["public"]["Enums"]["jurisdiction_code"]
          last_sync_at: string | null
          linked_at: string | null
          linked_by: string | null
          metadata: Json | null
          notes: string | null
          qbo_access_token: string | null
          qbo_company_name: string | null
          qbo_realm_id: string
          qbo_refresh_token: string | null
          qbo_token_expires_at: string | null
          state_province: string | null
          status: Database["public"]["Enums"]["client_status"]
          stripe_account_id: string | null
          stripe_access_token: string | null
          stripe_refresh_token: string | null
          stripe_connected_at: string | null
          stripe_connection_status: string | null
          updated_at: string | null
        }
        Insert: {
          assigned_bookkeeper_id?: string | null
          client_email?: string | null
          client_name: string
          created_at?: string | null
          double_client_id: string
          double_client_name?: string | null
          id?: string
          industry?: string | null
          is_active?: boolean | null
          jurisdiction: Database["public"]["Enums"]["jurisdiction_code"]
          last_sync_at?: string | null
          linked_at?: string | null
          linked_by?: string | null
          metadata?: Json | null
          notes?: string | null
          qbo_access_token?: string | null
          qbo_company_name?: string | null
          qbo_realm_id: string
          qbo_refresh_token?: string | null
          qbo_token_expires_at?: string | null
          state_province?: string | null
          status?: Database["public"]["Enums"]["client_status"]
          stripe_account_id?: string | null
          stripe_access_token?: string | null
          stripe_refresh_token?: string | null
          stripe_connected_at?: string | null
          stripe_connection_status?: string | null
          updated_at?: string | null
        }
        Update: {
          assigned_bookkeeper_id?: string | null
          client_email?: string | null
          client_name?: string
          created_at?: string | null
          double_client_id?: string
          double_client_name?: string | null
          id?: string
          industry?: string | null
          is_active?: boolean | null
          jurisdiction?: Database["public"]["Enums"]["jurisdiction_code"]
          last_sync_at?: string | null
          linked_at?: string | null
          linked_by?: string | null
          metadata?: Json | null
          notes?: string | null
          qbo_access_token?: string | null
          qbo_company_name?: string | null
          qbo_realm_id?: string
          qbo_refresh_token?: string | null
          qbo_token_expires_at?: string | null
          state_province?: string | null
          status?: Database["public"]["Enums"]["client_status"]
          stripe_account_id?: string | null
          stripe_access_token?: string | null
          stripe_refresh_token?: string | null
          stripe_connected_at?: string | null
          stripe_connection_status?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      stripe_connect_tokens: {
        Row: {
          client_link_id: string
          created_at: string | null
          created_by: string
          expires_at: string
          id: string
          token: string
          used_at: string | null
        }
        Insert: {
          client_link_id: string
          created_at?: string | null
          created_by: string
          expires_at: string
          id?: string
          token: string
          used_at?: string | null
        }
        Update: {
          client_link_id?: string
          created_at?: string | null
          created_by?: string
          expires_at?: string
          id?: string
          token?: string
          used_at?: string | null
        }
        Relationships: []
      }
      coa_actions: {
        Row: {
          action: Database["public"]["Enums"]["coa_action"]
          ai_confidence: number | null
          ai_reasoning: string | null
          ai_suggested_target: string | null
          bookkeeper_override: boolean | null
          created_at: string | null
          current_name: string | null
          current_subtype: string | null
          current_type: string | null
          error_message: string | null
          executed: boolean | null
          executed_at: string | null
          flagged_reason: string | null
          id: string
          job_id: string
          new_name: string | null
          new_parent_name: string | null
          new_qbo_account_id: string | null
          new_subtype: string | null
          new_type: string | null
          parent_qbo_id: string | null
          qbo_account_id: string | null
          qbo_response: Json | null
          sort_order: number | null
          tax_code_ref: string | null
          transaction_count: number | null
        }
        Insert: {
          action: Database["public"]["Enums"]["coa_action"]
          ai_confidence?: number | null
          ai_reasoning?: string | null
          ai_suggested_target?: string | null
          bookkeeper_override?: boolean | null
          created_at?: string | null
          current_name?: string | null
          current_subtype?: string | null
          current_type?: string | null
          error_message?: string | null
          executed?: boolean | null
          executed_at?: string | null
          flagged_reason?: string | null
          id?: string
          job_id: string
          new_name?: string | null
          new_parent_name?: string | null
          new_qbo_account_id?: string | null
          new_subtype?: string | null
          new_type?: string | null
          parent_qbo_id?: string | null
          qbo_account_id?: string | null
          qbo_response?: Json | null
          sort_order?: number | null
          tax_code_ref?: string | null
          transaction_count?: number | null
        }
        Update: {
          action?: Database["public"]["Enums"]["coa_action"]
          ai_confidence?: number | null
          ai_reasoning?: string | null
          ai_suggested_target?: string | null
          bookkeeper_override?: boolean | null
          created_at?: string | null
          current_name?: string | null
          current_subtype?: string | null
          current_type?: string | null
          error_message?: string | null
          executed?: boolean | null
          executed_at?: string | null
          flagged_reason?: string | null
          id?: string
          job_id?: string
          new_name?: string | null
          new_parent_name?: string | null
          new_qbo_account_id?: string | null
          new_subtype?: string | null
          new_type?: string | null
          parent_qbo_id?: string | null
          qbo_account_id?: string | null
          qbo_response?: Json | null
          sort_order?: number | null
          tax_code_ref?: string | null
          transaction_count?: number | null
        }
        Relationships: []
      }
      coa_jobs: {
        Row: {
          accounts_flagged: number | null
          accounts_to_create: number | null
          accounts_to_delete: number | null
          accounts_to_rename: number | null
          ai_completed_at: string | null
          ai_model_used: string | null
          ai_suggestions: Json | null
          bookkeeper_id: string
          client_link_id: string
          created_at: string | null
          current_coa_snapshot: Json | null
          error_message: string | null
          execution_completed_at: string | null
          execution_duration_seconds: number | null
          execution_started_at: string | null
          flagged_for_lisa: boolean | null
          id: string
          lisa_notes: string | null
          lisa_reviewed_at: string | null
          lisa_reviewed_by: string | null
          slack_message_ts: string | null
          snapshot_pulled_at: string | null
          status: Database["public"]["Enums"]["job_status"]
          transactions_to_reclassify: number | null
          updated_at: string | null
        }
        Insert: {
          accounts_flagged?: number | null
          accounts_to_create?: number | null
          accounts_to_delete?: number | null
          accounts_to_rename?: number | null
          ai_completed_at?: string | null
          ai_model_used?: string | null
          ai_suggestions?: Json | null
          bookkeeper_id: string
          client_link_id: string
          created_at?: string | null
          current_coa_snapshot?: Json | null
          error_message?: string | null
          execution_completed_at?: string | null
          execution_duration_seconds?: number | null
          execution_started_at?: string | null
          flagged_for_lisa?: boolean | null
          id?: string
          lisa_notes?: string | null
          lisa_reviewed_at?: string | null
          lisa_reviewed_by?: string | null
          slack_message_ts?: string | null
          snapshot_pulled_at?: string | null
          status?: Database["public"]["Enums"]["job_status"]
          transactions_to_reclassify?: number | null
          updated_at?: string | null
        }
        Update: {
          accounts_flagged?: number | null
          accounts_to_create?: number | null
          accounts_to_delete?: number | null
          accounts_to_rename?: number | null
          ai_completed_at?: string | null
          ai_model_used?: string | null
          ai_suggestions?: Json | null
          bookkeeper_id?: string
          client_link_id?: string
          created_at?: string | null
          current_coa_snapshot?: Json | null
          error_message?: string | null
          execution_completed_at?: string | null
          execution_duration_seconds?: number | null
          execution_started_at?: string | null
          flagged_for_lisa?: boolean | null
          id?: string
          lisa_notes?: string | null
          lisa_reviewed_at?: string | null
          lisa_reviewed_by?: string | null
          slack_message_ts?: string | null
          snapshot_pulled_at?: string | null
          status?: Database["public"]["Enums"]["job_status"]
          transactions_to_reclassify?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      integration_credentials: {
        Row: {
          created_at: string | null
          credential_name: string
          credential_value: string
          expires_at: string | null
          id: string
          metadata: Json | null
          service: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          credential_name: string
          credential_value: string
          expires_at?: string | null
          id?: string
          metadata?: Json | null
          service: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          credential_name?: string
          credential_value?: string
          expires_at?: string | null
          id?: string
          metadata?: Json | null
          service?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      master_coa: {
        Row: {
          account_name: string
          created_at: string | null
          expense_category:
            | Database["public"]["Enums"]["expense_category"]
            | null
          id: string
          industry: string | null
          is_parent: boolean | null
          is_required: boolean | null
          jurisdiction: Database["public"]["Enums"]["jurisdiction_code"]
          notes: string | null
          parent_account_name: string | null
          qbo_account_subtype: string
          qbo_account_type: string
          section: Database["public"]["Enums"]["account_section"]
          sort_order: number
          tax_treatment: Json | null
          typical_pct_revenue: number | null
          updated_at: string | null
        }
        Insert: {
          account_name: string
          created_at?: string | null
          expense_category?:
            | Database["public"]["Enums"]["expense_category"]
            | null
          id?: string
          industry?: string | null
          is_parent?: boolean | null
          is_required?: boolean | null
          jurisdiction: Database["public"]["Enums"]["jurisdiction_code"]
          notes?: string | null
          parent_account_name?: string | null
          qbo_account_subtype: string
          qbo_account_type: string
          section: Database["public"]["Enums"]["account_section"]
          sort_order?: number
          tax_treatment?: Json | null
          typical_pct_revenue?: number | null
          updated_at?: string | null
        }
        Update: {
          account_name?: string
          created_at?: string | null
          expense_category?:
            | Database["public"]["Enums"]["expense_category"]
            | null
          id?: string
          industry?: string | null
          is_parent?: boolean | null
          is_required?: boolean | null
          jurisdiction?: Database["public"]["Enums"]["jurisdiction_code"]
          notes?: string | null
          parent_account_name?: string | null
          qbo_account_subtype?: string
          qbo_account_type?: string
          section?: Database["public"]["Enums"]["account_section"]
          sort_order?: number
          tax_treatment?: Json | null
          typical_pct_revenue?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      reclass_jobs: {
        Row: {
          ai_completed_at: string | null
          attested: boolean | null
          attested_at: string | null
          auto_approve_threshold: number | null
          bookkeeper_id: string
          client_link_id: string
          created_at: string | null
          date_range_end: string
          date_range_start: string
          double_task_id: string | null
          error_message: string | null
          execution_completed_at: string | null
          execution_duration_seconds: number | null
          execution_started_at: string | null
          force_reconciled: boolean | null
          force_reconciled_at: string | null
          force_reconciled_by: string | null
          id: string
          is_rollback: boolean | null
          jurisdiction: Database["public"]["Enums"]["jurisdiction_code"]
          parent_job_id: string | null
          reason: string
          rolled_back: boolean | null
          rolled_back_at: string | null
          rolled_back_by: string | null
          source_account_id: string | null
          source_account_name: string | null
          state_province: string | null
          status: Database["public"]["Enums"]["job_status"]
          target_account_id: string | null
          target_account_name: string | null
          transactions_auto_approve: number | null
          transactions_failed: number | null
          transactions_flagged: number | null
          transactions_in_scope: number | null
          transactions_moved: number | null
          transactions_needs_review: number | null
          transactions_pulled: number | null
          transactions_skipped_closed: number | null
          transactions_skipped_reconciled: number | null
          transactions_skipped_unsupported: number | null
          unique_vendors_count: number | null
          updated_at: string | null
          warnings: Json | null
          workflow: Database["public"]["Enums"]["reclass_workflow"]
        }
        Insert: {
          ai_completed_at?: string | null
          attested?: boolean | null
          attested_at?: string | null
          auto_approve_threshold?: number | null
          bookkeeper_id: string
          client_link_id: string
          created_at?: string | null
          date_range_end: string
          date_range_start: string
          double_task_id?: string | null
          error_message?: string | null
          execution_completed_at?: string | null
          execution_duration_seconds?: number | null
          execution_started_at?: string | null
          force_reconciled?: boolean | null
          force_reconciled_at?: string | null
          force_reconciled_by?: string | null
          id?: string
          is_rollback?: boolean | null
          jurisdiction: Database["public"]["Enums"]["jurisdiction_code"]
          parent_job_id?: string | null
          reason: string
          rolled_back?: boolean | null
          rolled_back_at?: string | null
          rolled_back_by?: string | null
          source_account_id?: string | null
          source_account_name?: string | null
          state_province?: string | null
          status?: Database["public"]["Enums"]["job_status"]
          target_account_id?: string | null
          target_account_name?: string | null
          transactions_auto_approve?: number | null
          transactions_failed?: number | null
          transactions_flagged?: number | null
          transactions_in_scope?: number | null
          transactions_moved?: number | null
          transactions_needs_review?: number | null
          transactions_pulled?: number | null
          transactions_skipped_closed?: number | null
          transactions_skipped_reconciled?: number | null
          transactions_skipped_unsupported?: number | null
          unique_vendors_count?: number | null
          updated_at?: string | null
          warnings?: Json | null
          workflow: Database["public"]["Enums"]["reclass_workflow"]
        }
        Update: {
          ai_completed_at?: string | null
          attested?: boolean | null
          attested_at?: string | null
          auto_approve_threshold?: number | null
          bookkeeper_id?: string
          client_link_id?: string
          created_at?: string | null
          date_range_end?: string
          date_range_start?: string
          double_task_id?: string | null
          error_message?: string | null
          execution_completed_at?: string | null
          execution_duration_seconds?: number | null
          execution_started_at?: string | null
          force_reconciled?: boolean | null
          force_reconciled_at?: string | null
          force_reconciled_by?: string | null
          id?: string
          is_rollback?: boolean | null
          jurisdiction?: Database["public"]["Enums"]["jurisdiction_code"]
          parent_job_id?: string | null
          reason?: string
          rolled_back?: boolean | null
          rolled_back_at?: string | null
          rolled_back_by?: string | null
          source_account_id?: string
          source_account_name?: string
          state_province?: string | null
          status?: Database["public"]["Enums"]["job_status"]
          target_account_id?: string | null
          target_account_name?: string | null
          transactions_auto_approve?: number | null
          transactions_failed?: number | null
          transactions_flagged?: number | null
          transactions_in_scope?: number | null
          transactions_moved?: number | null
          transactions_needs_review?: number | null
          transactions_pulled?: number | null
          transactions_skipped_closed?: number | null
          transactions_skipped_reconciled?: number | null
          transactions_skipped_unsupported?: number | null
          unique_vendors_count?: number | null
          updated_at?: string | null
          warnings?: Json | null
          workflow?: Database["public"]["Enums"]["reclass_workflow"]
        }
        Relationships: []
      }
      reclassifications: {
        Row: {
          action_id: string | null
          ai_confidence: number | null
          ai_reasoning: string | null
          bookkeeper_override: boolean | null
          bookkeeper_override_target_id: string | null
          bookkeeper_override_target_name: string | null
          created_at: string | null
          decision: Database["public"]["Enums"]["reclass_decision"]
          description: string | null
          error_message: string | null
          executed_at: string | null
          from_account_id: string
          from_account_name: string | null
          id: string
          is_bank_fed: boolean | null
          is_manual_entry: boolean | null
          is_reconciled: boolean | null
          job_id: string
          line_id: string | null
          original_memo: string | null
          qbo_transaction_id: string
          qbo_transaction_type: string | null
          reclass_job_id: string | null
          skip_reason: Database["public"]["Enums"]["reclass_skip_reason"] | null
          status: string | null
          sync_token: string | null
          to_account_id: string
          to_account_name: string | null
          transaction_amount: number | null
          transaction_date: string | null
          vendor_name: string | null
          vendor_pattern_normalized: string | null
        }
        Insert: {
          action_id?: string | null
          ai_confidence?: number | null
          ai_reasoning?: string | null
          bookkeeper_override?: boolean | null
          bookkeeper_override_target_id?: string | null
          bookkeeper_override_target_name?: string | null
          created_at?: string | null
          decision?: Database["public"]["Enums"]["reclass_decision"]
          description?: string | null
          error_message?: string | null
          executed_at?: string | null
          from_account_id: string
          from_account_name?: string | null
          id?: string
          is_bank_fed?: boolean | null
          is_manual_entry?: boolean | null
          is_reconciled?: boolean | null
          job_id: string
          line_id?: string | null
          original_memo?: string | null
          qbo_transaction_id: string
          qbo_transaction_type?: string | null
          reclass_job_id?: string | null
          skip_reason?:
            | Database["public"]["Enums"]["reclass_skip_reason"]
            | null
          status?: string | null
          sync_token?: string | null
          to_account_id: string
          to_account_name?: string | null
          transaction_amount?: number | null
          transaction_date?: string | null
          vendor_name?: string | null
          vendor_pattern_normalized?: string | null
        }
        Update: {
          action_id?: string | null
          ai_confidence?: number | null
          ai_reasoning?: string | null
          bookkeeper_override?: boolean | null
          bookkeeper_override_target_id?: string | null
          bookkeeper_override_target_name?: string | null
          created_at?: string | null
          decision?: Database["public"]["Enums"]["reclass_decision"]
          description?: string | null
          error_message?: string | null
          executed_at?: string | null
          from_account_id?: string
          from_account_name?: string | null
          id?: string
          is_bank_fed?: boolean | null
          is_manual_entry?: boolean | null
          is_reconciled?: boolean | null
          job_id?: string
          line_id?: string | null
          original_memo?: string | null
          qbo_transaction_id?: string
          qbo_transaction_type?: string | null
          reclass_job_id?: string | null
          skip_reason?:
            | Database["public"]["Enums"]["reclass_skip_reason"]
            | null
          status?: string | null
          sync_token?: string | null
          to_account_id?: string
          to_account_name?: string | null
          transaction_amount?: number | null
          transaction_date?: string | null
          vendor_name?: string | null
          vendor_pattern_normalized?: string | null
        }
        Relationships: []
      }
      rule_discovery_jobs: {
        Row: {
          ai_completed_at: string | null
          bookkeeper_id: string
          client_link_id: string
          created_at: string | null
          error_message: string | null
          execution_completed_at: string | null
          execution_started_at: string | null
          id: string
          months_analyzed: number | null
          rules_approved: number | null
          rules_pushed: number | null
          rules_suggested: number | null
          status: Database["public"]["Enums"]["job_status"]
          transactions_pulled: number | null
          updated_at: string | null
          vendors_identified: number | null
        }
        Insert: {
          ai_completed_at?: string | null
          bookkeeper_id: string
          client_link_id: string
          created_at?: string | null
          error_message?: string | null
          execution_completed_at?: string | null
          execution_started_at?: string | null
          id?: string
          months_analyzed?: number | null
          rules_approved?: number | null
          rules_pushed?: number | null
          rules_suggested?: number | null
          status?: Database["public"]["Enums"]["job_status"]
          transactions_pulled?: number | null
          updated_at?: string | null
          vendors_identified?: number | null
        }
        Update: {
          ai_completed_at?: string | null
          bookkeeper_id?: string
          client_link_id?: string
          created_at?: string | null
          error_message?: string | null
          execution_completed_at?: string | null
          execution_started_at?: string | null
          id?: string
          months_analyzed?: number | null
          rules_approved?: number | null
          rules_pushed?: number | null
          rules_suggested?: number | null
          status?: Database["public"]["Enums"]["job_status"]
          transactions_pulled?: number | null
          updated_at?: string | null
          vendors_identified?: number | null
        }
        Relationships: []
      }
      stripe_recon_jobs: {
        Row: {
          ai_completed_at: string | null
          bookkeeper_id: string
          client_link_id: string
          created_at: string | null
          date_range_end: string
          date_range_start: string
          error_message: string | null
          execution_completed_at: string | null
          execution_duration_seconds: number | null
          id: string
          jurisdiction: string
          reclass_job_id: string | null
          state_province: string | null
          status: string
          stripe_deposits_found: number | null
          total_fees: number | null
          total_matched_amount: number | null
          total_tax: number | null
          updated_at: string | null
          warnings: Json | null
        }
        Insert: {
          ai_completed_at?: string | null
          bookkeeper_id: string
          client_link_id: string
          created_at?: string | null
          date_range_end: string
          date_range_start: string
          error_message?: string | null
          execution_completed_at?: string | null
          execution_duration_seconds?: number | null
          id?: string
          jurisdiction: string
          reclass_job_id?: string | null
          state_province?: string | null
          status?: string
          stripe_deposits_found?: number | null
          total_fees?: number | null
          total_matched_amount?: number | null
          total_tax?: number | null
          updated_at?: string | null
          warnings?: Json | null
        }
        Update: {
          ai_completed_at?: string | null
          bookkeeper_id?: string
          client_link_id?: string
          created_at?: string | null
          date_range_end?: string
          date_range_start?: string
          error_message?: string | null
          execution_completed_at?: string | null
          execution_duration_seconds?: number | null
          id?: string
          jurisdiction?: string
          reclass_job_id?: string | null
          state_province?: string | null
          status?: string
          stripe_deposits_found?: number | null
          total_fees?: number | null
          total_matched_amount?: number | null
          total_tax?: number | null
          updated_at?: string | null
          warnings?: Json | null
        }
        Relationships: []
      }
      stripe_recon_matches: {
        Row: {
          ai_confidence: number | null
          ai_reasoning: string | null
          bookkeeper_override: boolean | null
          computed_fee: number | null
          computed_tax: number | null
          created_at: string | null
          decision: "auto_approve" | "needs_review" | "flagged"
          deposit_amount: number
          deposit_date: string
          deposit_memo: string | null
          error_message: string | null
          executed: boolean | null
          executed_at: string | null
          id: string
          job_id: string
          matched_customer_names: string[] | null
          matched_invoices: Json | null
          pre_tax_revenue: number | null
          qbo_deposit_id: string
          qbo_deposit_txn_type: string | null
          tax_code: string | null
          total_invoice_amount: number | null
          total_sales_tax_collected: number | null
        }
        Insert: {
          ai_confidence?: number | null
          ai_reasoning?: string | null
          bookkeeper_override?: boolean | null
          computed_fee?: number | null
          computed_tax?: number | null
          created_at?: string | null
          decision?: "auto_approve" | "needs_review" | "flagged"
          deposit_amount: number
          deposit_date: string
          deposit_memo?: string | null
          error_message?: string | null
          executed?: boolean | null
          executed_at?: string | null
          id?: string
          job_id: string
          matched_customer_names?: string[] | null
          matched_invoices?: Json | null
          pre_tax_revenue?: number | null
          qbo_deposit_id: string
          qbo_deposit_txn_type?: string | null
          tax_code?: string | null
          total_invoice_amount?: number | null
          total_sales_tax_collected?: number | null
        }
        Update: {
          ai_confidence?: number | null
          ai_reasoning?: string | null
          bookkeeper_override?: boolean | null
          computed_fee?: number | null
          computed_tax?: number | null
          created_at?: string | null
          decision?: "auto_approve" | "needs_review" | "flagged"
          deposit_amount?: number
          deposit_date?: string
          deposit_memo?: string | null
          error_message?: string | null
          executed?: boolean | null
          executed_at?: string | null
          id?: string
          job_id?: string
          matched_customer_names?: string[] | null
          matched_invoices?: Json | null
          pre_tax_revenue?: number | null
          qbo_deposit_id?: string
          qbo_deposit_txn_type?: string | null
          tax_code?: string | null
          total_invoice_amount?: number | null
          total_sales_tax_collected?: number | null
        }
        Relationships: []
      }
      users: {
        Row: {
          avatar_url: string | null
          created_at: string | null
          email: string
          full_name: string
          id: string
          invited_at: string | null
          invited_by: string | null
          is_active: boolean | null
          last_login_at: string | null
          role: Database["public"]["Enums"]["user_role"]
          updated_at: string | null
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string | null
          email: string
          full_name: string
          id: string
          invited_at?: string | null
          invited_by?: string | null
          is_active?: boolean | null
          last_login_at?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string | null
        }
        Update: {
          avatar_url?: string | null
          created_at?: string | null
          email?: string
          full_name?: string
          id?: string
          invited_at?: string | null
          invited_by?: string | null
          is_active?: boolean | null
          last_login_at?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      active_jobs_view: {
        Row: {
          accounts_flagged: number | null
          accounts_to_create: number | null
          accounts_to_rename: number | null
          bookkeeper_avatar: string | null
          bookkeeper_name: string | null
          client_name: string | null
          created_at: string | null
          flagged_for_lisa: boolean | null
          id: string | null
          jurisdiction: Database["public"]["Enums"]["jurisdiction_code"] | null
          state_province: string | null
          status: Database["public"]["Enums"]["job_status"] | null
        }
        Relationships: []
      }
      client_activity_history: {
        Row: {
          active_rules: number | null
          client_created_at: string | null
          client_link_id: string | null
          client_name: string | null
          completed_cleanups: number | null
          jurisdiction: Database["public"]["Enums"]["jurisdiction_code"] | null
          last_cleanup_at: string | null
          state_province: string | null
          total_cleanups: number | null
          total_rules: number | null
        }
        Insert: {
          active_rules?: never
          client_created_at?: string | null
          client_link_id?: string | null
          client_name?: string | null
          completed_cleanups?: never
          jurisdiction?: Database["public"]["Enums"]["jurisdiction_code"] | null
          last_cleanup_at?: never
          state_province?: string | null
          total_cleanups?: never
          total_rules?: never
        }
        Update: {
          active_rules?: never
          client_created_at?: string | null
          client_link_id?: string | null
          client_name?: string | null
          completed_cleanups?: never
          jurisdiction?: Database["public"]["Enums"]["jurisdiction_code"] | null
          last_cleanup_at?: never
          state_province?: string | null
          total_cleanups?: never
          total_rules?: never
        }
        Relationships: []
      }
      client_list_view: {
        Row: {
          active_cleanups: number | null
          active_rules: number | null
          assigned_bookkeeper_avatar: string | null
          assigned_bookkeeper_id: string | null
          assigned_bookkeeper_name: string | null
          client_email: string | null
          client_name: string | null
          completed_cleanups: number | null
          created_at: string | null
          double_client_id: string | null
          flagged_cleanups: number | null
          id: string | null
          is_active: boolean | null
          jurisdiction: Database["public"]["Enums"]["jurisdiction_code"] | null
          last_cleanup_at: string | null
          qbo_realm_id: string | null
          qbo_token_expires_at: string | null
          state_province: string | null
          status: Database["public"]["Enums"]["client_status"] | null
          total_cleanups: number | null
        }
        Relationships: []
      }
      dashboard_stats: {
        Row: {
          active_jobs: number | null
          avg_duration_seconds: number | null
          completed_this_week: number | null
          flagged_for_lisa: number | null
        }
        Relationships: []
      }
      master_coa_usage: {
        Row: {
          account_name: string | null
          id: string | null
          jurisdiction: Database["public"]["Enums"]["jurisdiction_code"] | null
          times_used_in_cleanups: number | null
          times_used_in_rules: number | null
        }
        Insert: {
          account_name?: string | null
          id?: string | null
          jurisdiction?: Database["public"]["Enums"]["jurisdiction_code"] | null
          times_used_in_cleanups?: never
          times_used_in_rules?: never
        }
        Update: {
          account_name?: string | null
          id?: string | null
          jurisdiction?: Database["public"]["Enums"]["jurisdiction_code"] | null
          times_used_in_cleanups?: never
          times_used_in_rules?: never
        }
        Relationships: []
      }
      recent_activity_feed: {
        Row: {
          action_id: string | null
          client_link_id: string | null
          client_name: string | null
          error_message: string | null
          event_type: string | null
          id: string | null
          job_id: string | null
          jurisdiction: Database["public"]["Enums"]["jurisdiction_code"] | null
          occurred_at: string | null
          request_payload: Json | null
          response_payload: Json | null
          user_avatar: string | null
          user_id: string | null
          user_name: string | null
          user_role: Database["public"]["Enums"]["user_role"] | null
        }
        Relationships: []
      }
      reclass_jobs_view: {
        Row: {
          ai_completed_at: string | null
          attested: boolean | null
          attested_at: string | null
          bookkeeper_avatar: string | null
          bookkeeper_id: string | null
          bookkeeper_name: string | null
          client_jurisdiction:
            | Database["public"]["Enums"]["jurisdiction_code"]
            | null
          client_link_id: string | null
          client_name: string | null
          created_at: string | null
          date_range_end: string | null
          date_range_start: string | null
          double_task_id: string | null
          error_message: string | null
          execution_completed_at: string | null
          execution_duration_seconds: number | null
          execution_started_at: string | null
          force_reconciled: boolean | null
          force_reconciled_at: string | null
          force_reconciled_by: string | null
          id: string | null
          is_rollback: boolean | null
          jurisdiction: Database["public"]["Enums"]["jurisdiction_code"] | null
          parent_job_id: string | null
          reason: string | null
          rolled_back: boolean | null
          rolled_back_at: string | null
          rolled_back_by: string | null
          source_account_id: string | null
          source_account_name: string | null
          state_province: string | null
          status: Database["public"]["Enums"]["job_status"] | null
          target_account_id: string | null
          target_account_name: string | null
          transactions_auto_approve: number | null
          transactions_failed: number | null
          transactions_flagged: number | null
          transactions_in_scope: number | null
          transactions_moved: number | null
          transactions_needs_review: number | null
          transactions_pulled: number | null
          transactions_skipped_closed: number | null
          transactions_skipped_reconciled: number | null
          transactions_skipped_unsupported: number | null
          unique_vendors_count: number | null
          updated_at: string | null
          warnings: Json | null
          workflow: Database["public"]["Enums"]["reclass_workflow"] | null
        }
        Relationships: []
      }
      user_activity_stats: {
        Row: {
          active_cleanups: number | null
          avg_duration_seconds: number | null
          cleanups_this_month: number | null
          cleanups_this_week: number | null
          completed_cleanups: number | null
          created_at: string | null
          email: string | null
          failed_cleanups: number | null
          flags_reviewed: number | null
          full_name: string | null
          id: string | null
          is_active: boolean | null
          last_activity_at: string | null
          last_login_at: string | null
          role: Database["public"]["Enums"]["user_role"] | null
          total_cleanups: number | null
          total_rule_jobs: number | null
          total_rules_pushed: number | null
        }
        Insert: {
          active_cleanups?: never
          avg_duration_seconds?: never
          cleanups_this_month?: never
          cleanups_this_week?: never
          completed_cleanups?: never
          created_at?: string | null
          email?: string | null
          failed_cleanups?: never
          flags_reviewed?: never
          full_name?: string | null
          id?: string | null
          is_active?: boolean | null
          last_activity_at?: never
          last_login_at?: string | null
          role?: Database["public"]["Enums"]["user_role"] | null
          total_cleanups?: never
          total_rule_jobs?: never
          total_rules_pushed?: never
        }
        Update: {
          active_cleanups?: never
          avg_duration_seconds?: never
          cleanups_this_month?: never
          cleanups_this_week?: never
          completed_cleanups?: never
          created_at?: string | null
          email?: string | null
          failed_cleanups?: never
          flags_reviewed?: never
          full_name?: string | null
          id?: string | null
          is_active?: boolean | null
          last_activity_at?: never
          last_login_at?: string | null
          role?: Database["public"]["Enums"]["user_role"] | null
          total_cleanups?: never
          total_rule_jobs?: never
          total_rules_pushed?: never
        }
        Relationships: []
      }
    }
    Functions: {
      is_lead_or_admin: { Args: Record<string, never>; Returns: boolean }
      is_team_member: { Args: Record<string, never>; Returns: boolean }
    }
    Enums: {
      account_section:
        | "revenue"
        | "cogs"
        | "gross_profit"
        | "operating_expense"
        | "other_income"
        | "other_expense"
        | "equity"
        | "asset"
        | "liability"
      client_status: "onboarding" | "active" | "behind" | "paused" | "churned"
      coa_action: "keep" | "rename" | "delete" | "flag" | "create" | "merge"
      expense_category:
        | "marketing"
        | "salaries_payroll"
        | "general_operating"
        | "cogs"
      job_status:
        | "draft"
        | "in_review"
        | "pending_lisa"
        | "approved"
        | "executing"
        | "complete"
        | "failed"
        | "cancelled"
      jurisdiction_code: "US" | "CA"
      reclass_decision:
        | "pending"
        | "auto_approve"
        | "needs_review"
        | "flagged"
        | "approved"
        | "rejected"
        | "skip"
        | "ask_client"
      reclass_skip_reason:
        | "reconciled"
        | "closed_period_qbo"
        | "closed_period_double"
        | "unsupported_type"
        | "user_excluded"
        | "manual_entry"
      reclass_workflow: "consolidation" | "scrub" | "full_categorization"
      user_role: "admin" | "lead" | "bookkeeper" | "viewer"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      account_section: [
        "revenue",
        "cogs",
        "gross_profit",
        "operating_expense",
        "other_income",
        "other_expense",
        "equity",
        "asset",
        "liability",
      ],
      client_status: ["onboarding", "active", "behind", "paused", "churned"],
      coa_action: ["keep", "rename", "delete", "flag", "create", "merge"],
      expense_category: [
        "marketing",
        "salaries_payroll",
        "general_operating",
        "cogs",
      ],
      job_status: [
        "draft",
        "in_review",
        "pending_lisa",
        "approved",
        "executing",
        "complete",
        "failed",
        "cancelled",
      ],
      jurisdiction_code: ["US", "CA"],
      reclass_decision: [
        "pending",
        "auto_approve",
        "needs_review",
        "flagged",
        "approved",
        "rejected",
        "skip",
        "ask_client",
      ],
      reclass_skip_reason: [
        "reconciled",
        "closed_period_qbo",
        "closed_period_double",
        "unsupported_type",
        "user_excluded",
        "manual_entry",
      ],
      reclass_workflow: ["consolidation", "scrub", "full_categorization"],
      user_role: ["admin", "lead", "bookkeeper", "viewer"],
    },
  },
} as const
