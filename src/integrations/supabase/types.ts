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
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      agent: {
        Row: {
          applied_today: number | null
          current_job: string | null
          id: number
          last_seen: string | null
          online: boolean | null
          state: string | null
          version: string | null
        }
        Insert: {
          applied_today?: number | null
          current_job?: string | null
          id?: number
          last_seen?: string | null
          online?: boolean | null
          state?: string | null
          version?: string | null
        }
        Update: {
          applied_today?: number | null
          current_job?: string | null
          id?: number
          last_seen?: string | null
          online?: boolean | null
          state?: string | null
          version?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_current_job_fkey"
            columns: ["current_job"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_current_job_fkey"
            columns: ["current_job"]
            isOneToOne: false
            referencedRelation: "v_apply_queue"
            referencedColumns: ["id"]
          },
        ]
      }
      answers: {
        Row: {
          answer: string
          confirmed: boolean | null
          created_at: string | null
          field_type: string | null
          generated: boolean | null
          id: string
          last_used: string | null
          options: Json
          q_key: string
          question: string
          reusable: boolean | null
          times_used: number | null
        }
        Insert: {
          answer: string
          confirmed?: boolean | null
          created_at?: string | null
          field_type?: string | null
          generated?: boolean | null
          id?: string
          last_used?: string | null
          options?: Json
          q_key: string
          question: string
          reusable?: boolean | null
          times_used?: number | null
        }
        Update: {
          answer?: string
          confirmed?: boolean | null
          created_at?: string | null
          field_type?: string | null
          generated?: boolean | null
          id?: string
          last_used?: string | null
          options?: Json
          q_key?: string
          question?: string
          reusable?: boolean | null
          times_used?: number | null
        }
        Relationships: []
      }
      app_owner: {
        Row: {
          user_id: string
        }
        Insert: {
          user_id: string
        }
        Update: {
          user_id?: string
        }
        Relationships: []
      }
      companies: {
        Row: {
          ats: string
          careers_url: string | null
          created_at: string | null
          enabled: boolean | null
          id: string
          job_count: number | null
          last_error: string | null
          last_pulled: string | null
          name: string
          pod: string | null
          site: string | null
          token: string
        }
        Insert: {
          ats: string
          careers_url?: string | null
          created_at?: string | null
          enabled?: boolean | null
          id?: string
          job_count?: number | null
          last_error?: string | null
          last_pulled?: string | null
          name: string
          pod?: string | null
          site?: string | null
          token: string
        }
        Update: {
          ats?: string
          careers_url?: string | null
          created_at?: string | null
          enabled?: boolean | null
          id?: string
          job_count?: number | null
          last_error?: string | null
          last_pulled?: string | null
          name?: string
          pod?: string | null
          site?: string | null
          token?: string
        }
        Relationships: []
      }
      company_candidates: {
        Row: {
          ats: string | null
          careers_url: string
          checked_at: string | null
          created_at: string | null
          id: string
          name: string
          note: string | null
          pod: string | null
          resolved_url: string | null
          site: string | null
          status: string
          token: string | null
        }
        Insert: {
          ats?: string | null
          careers_url: string
          checked_at?: string | null
          created_at?: string | null
          id?: string
          name: string
          note?: string | null
          pod?: string | null
          resolved_url?: string | null
          site?: string | null
          status?: string
          token?: string | null
        }
        Update: {
          ats?: string | null
          careers_url?: string
          checked_at?: string | null
          created_at?: string | null
          id?: string
          name?: string
          note?: string | null
          pod?: string | null
          resolved_url?: string | null
          site?: string | null
          status?: string
          token?: string | null
        }
        Relationships: []
      }
      email_sync: {
        Row: {
          gmail_history_id: string | null
          id: number
          last_error: string | null
          last_run_at: string | null
          last_seen_at: string | null
          last_status: string | null
          seen_count: number | null
          source: string | null
        }
        Insert: {
          gmail_history_id?: string | null
          id?: number
          last_error?: string | null
          last_run_at?: string | null
          last_seen_at?: string | null
          last_status?: string | null
          seen_count?: number | null
          source?: string | null
        }
        Update: {
          gmail_history_id?: string | null
          id?: number
          last_error?: string | null
          last_run_at?: string | null
          last_seen_at?: string | null
          last_status?: string | null
          seen_count?: number | null
          source?: string | null
        }
        Relationships: []
      }
      emails: {
        Row: {
          body: string | null
          category: string | null
          classify_why: string | null
          confidence: string | null
          created_at: string | null
          direction: string | null
          from_addr: string | null
          id: string
          is_read: boolean | null
          job_id: string | null
          message_id: string
          moment: string | null
          notified_at: string | null
          received_at: string | null
          replied_at: string | null
          reply_draft: string | null
          reply_error: string | null
          reply_state: string | null
          snippet: string | null
          subject: string | null
          thread_id: string | null
          to_addr: string | null
        }
        Insert: {
          body?: string | null
          category?: string | null
          classify_why?: string | null
          confidence?: string | null
          created_at?: string | null
          direction?: string | null
          from_addr?: string | null
          id?: string
          is_read?: boolean | null
          job_id?: string | null
          message_id: string
          moment?: string | null
          notified_at?: string | null
          received_at?: string | null
          replied_at?: string | null
          reply_draft?: string | null
          reply_error?: string | null
          reply_state?: string | null
          snippet?: string | null
          subject?: string | null
          thread_id?: string | null
          to_addr?: string | null
        }
        Update: {
          body?: string | null
          category?: string | null
          classify_why?: string | null
          confidence?: string | null
          created_at?: string | null
          direction?: string | null
          from_addr?: string | null
          id?: string
          is_read?: boolean | null
          job_id?: string | null
          message_id?: string
          moment?: string | null
          notified_at?: string | null
          received_at?: string | null
          replied_at?: string | null
          reply_draft?: string | null
          reply_error?: string | null
          reply_state?: string | null
          snippet?: string | null
          subject?: string | null
          thread_id?: string | null
          to_addr?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "emails_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "emails_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_apply_queue"
            referencedColumns: ["id"]
          },
        ]
      }
      experience: {
        Row: {
          company: string
          created_at: string
          details: string | null
          end_date: string | null
          id: string
          location: string | null
          start_date: string | null
          title: string
          updated_at: string
        }
        Insert: {
          company: string
          created_at?: string
          details?: string | null
          end_date?: string | null
          id?: string
          location?: string | null
          start_date?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          company?: string
          created_at?: string
          details?: string | null
          end_date?: string | null
          id?: string
          location?: string | null
          start_date?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      geo_cache: {
        Row: {
          created_at: string | null
          found: boolean | null
          lat: number | null
          lon: number | null
          place: string
        }
        Insert: {
          created_at?: string | null
          found?: boolean | null
          lat?: number | null
          lon?: number | null
          place: string
        }
        Update: {
          created_at?: string | null
          found?: boolean | null
          lat?: number | null
          lon?: number | null
          place?: string
        }
        Relationships: []
      }
      google_tokens: {
        Row: {
          access_token: string | null
          connected_at: string | null
          email: string | null
          expires_at: string | null
          id: number
          last_error: string | null
          last_sync_at: string | null
          refresh_token: string | null
          scope: string | null
        }
        Insert: {
          access_token?: string | null
          connected_at?: string | null
          email?: string | null
          expires_at?: string | null
          id?: number
          last_error?: string | null
          last_sync_at?: string | null
          refresh_token?: string | null
          scope?: string | null
        }
        Update: {
          access_token?: string | null
          connected_at?: string | null
          email?: string | null
          expires_at?: string | null
          id?: number
          last_error?: string | null
          last_sync_at?: string | null
          refresh_token?: string | null
          scope?: string | null
        }
        Relationships: []
      }
      heartbeat: {
        Row: {
          at: string
          name: string
        }
        Insert: {
          at?: string
          name: string
        }
        Update: {
          at?: string
          name?: string
        }
        Relationships: []
      }
      jobs: {
        Row: {
          applied_at: string | null
          apply_url: string | null
          ats: string | null
          attempts: number | null
          company: string | null
          confirm_state: string | null
          confirmed_at: string | null
          description: string | null
          distance_miles: number | null
          found_at: string | null
          help_reason: string | null
          id: string
          last_error: string | null
          lat: number | null
          location: string | null
          lon: number | null
          posted_at: string | null
          remote: boolean | null
          salary_max: number | null
          salary_min: number | null
          salary_text: string | null
          score: number | null
          score_reason: string | null
          scored_at: string | null
          skip_reason: string | null
          source: string | null
          status: string
          tailored_at: string | null
          tailored_resume: string | null
          title: string
          updated_at: string | null
          url: string
        }
        Insert: {
          applied_at?: string | null
          apply_url?: string | null
          ats?: string | null
          attempts?: number | null
          company?: string | null
          confirm_state?: string | null
          confirmed_at?: string | null
          description?: string | null
          distance_miles?: number | null
          found_at?: string | null
          help_reason?: string | null
          id?: string
          last_error?: string | null
          lat?: number | null
          location?: string | null
          lon?: number | null
          posted_at?: string | null
          remote?: boolean | null
          salary_max?: number | null
          salary_min?: number | null
          salary_text?: string | null
          score?: number | null
          score_reason?: string | null
          scored_at?: string | null
          skip_reason?: string | null
          source?: string | null
          status?: string
          tailored_at?: string | null
          tailored_resume?: string | null
          title: string
          updated_at?: string | null
          url: string
        }
        Update: {
          applied_at?: string | null
          apply_url?: string | null
          ats?: string | null
          attempts?: number | null
          company?: string | null
          confirm_state?: string | null
          confirmed_at?: string | null
          description?: string | null
          distance_miles?: number | null
          found_at?: string | null
          help_reason?: string | null
          id?: string
          last_error?: string | null
          lat?: number | null
          location?: string | null
          lon?: number | null
          posted_at?: string | null
          remote?: boolean | null
          salary_max?: number | null
          salary_min?: number | null
          salary_text?: string | null
          score?: number | null
          score_reason?: string | null
          scored_at?: string | null
          skip_reason?: string | null
          source?: string | null
          status?: string
          tailored_at?: string | null
          tailored_resume?: string | null
          title?: string
          updated_at?: string | null
          url?: string
        }
        Relationships: []
      }
      outreach: {
        Row: {
          body: string | null
          company: string
          created_at: string
          found_on: string | null
          id: string
          job_id: string | null
          reason: string | null
          sent_at: string | null
          state: string
          subject: string | null
          to_addr: string | null
        }
        Insert: {
          body?: string | null
          company: string
          created_at?: string
          found_on?: string | null
          id?: string
          job_id?: string | null
          reason?: string | null
          sent_at?: string | null
          state?: string
          subject?: string | null
          to_addr?: string | null
        }
        Update: {
          body?: string | null
          company?: string
          created_at?: string
          found_on?: string | null
          id?: string
          job_id?: string | null
          reason?: string | null
          sent_at?: string | null
          state?: string
          subject?: string | null
          to_addr?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "outreach_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outreach_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_apply_queue"
            referencedColumns: ["id"]
          },
        ]
      }
      profile: {
        Row: {
          address: string | null
          auto_reply: boolean | null
          autopilot: boolean | null
          availability: string | null
          availability_slots: Json
          can_background_check: string | null
          citizenship: string | null
          city: string | null
          country: string | null
          create_accounts: boolean | null
          daily_summary: boolean | null
          date_of_birth: string | null
          disability_status: string | null
          earliest_start: string | null
          education_level: string | null
          email: string | null
          follow_up: boolean | null
          full_name: string | null
          gender: string | null
          github_url: string | null
          health_notified_at: string | null
          health_state: string | null
          hispanic_latino: string | null
          home_city: string | null
          home_lat: number | null
          home_lon: number | null
          home_state: string | null
          id: number
          interview_holds: Json
          linkedin_url: string | null
          needs_sponsorship: string | null
          notify_moments: boolean
          over_18: string | null
          phone: string | null
          portfolio_url: string | null
          postal_code: string | null
          preferred_name: string | null
          race_ethnicity: string | null
          resume_error: string | null
          resume_file_name: string | null
          resume_file_path: string | null
          resume_text: string | null
          resume_word_count: number | null
          salary_expectation: number | null
          salary_min: number | null
          state: string | null
          target_role: string | null
          updated_at: string | null
          veteran_status: string | null
          willing_to_relocate: string | null
          work_authorized: string | null
          years_experience: string | null
        }
        Insert: {
          address?: string | null
          auto_reply?: boolean | null
          autopilot?: boolean | null
          availability?: string | null
          availability_slots?: Json
          can_background_check?: string | null
          citizenship?: string | null
          city?: string | null
          country?: string | null
          create_accounts?: boolean | null
          daily_summary?: boolean | null
          date_of_birth?: string | null
          disability_status?: string | null
          earliest_start?: string | null
          education_level?: string | null
          email?: string | null
          follow_up?: boolean | null
          full_name?: string | null
          gender?: string | null
          github_url?: string | null
          health_notified_at?: string | null
          health_state?: string | null
          hispanic_latino?: string | null
          home_city?: string | null
          home_lat?: number | null
          home_lon?: number | null
          home_state?: string | null
          id?: number
          interview_holds?: Json
          linkedin_url?: string | null
          needs_sponsorship?: string | null
          notify_moments?: boolean
          over_18?: string | null
          phone?: string | null
          portfolio_url?: string | null
          postal_code?: string | null
          preferred_name?: string | null
          race_ethnicity?: string | null
          resume_error?: string | null
          resume_file_name?: string | null
          resume_file_path?: string | null
          resume_text?: string | null
          resume_word_count?: number | null
          salary_expectation?: number | null
          salary_min?: number | null
          state?: string | null
          target_role?: string | null
          updated_at?: string | null
          veteran_status?: string | null
          willing_to_relocate?: string | null
          work_authorized?: string | null
          years_experience?: string | null
        }
        Update: {
          address?: string | null
          auto_reply?: boolean | null
          autopilot?: boolean | null
          availability?: string | null
          availability_slots?: Json
          can_background_check?: string | null
          citizenship?: string | null
          city?: string | null
          country?: string | null
          create_accounts?: boolean | null
          daily_summary?: boolean | null
          date_of_birth?: string | null
          disability_status?: string | null
          earliest_start?: string | null
          education_level?: string | null
          email?: string | null
          follow_up?: boolean | null
          full_name?: string | null
          gender?: string | null
          github_url?: string | null
          health_notified_at?: string | null
          health_state?: string | null
          hispanic_latino?: string | null
          home_city?: string | null
          home_lat?: number | null
          home_lon?: number | null
          home_state?: string | null
          id?: number
          interview_holds?: Json
          linkedin_url?: string | null
          needs_sponsorship?: string | null
          notify_moments?: boolean
          over_18?: string | null
          phone?: string | null
          portfolio_url?: string | null
          postal_code?: string | null
          preferred_name?: string | null
          race_ethnicity?: string | null
          resume_error?: string | null
          resume_file_name?: string | null
          resume_file_path?: string | null
          resume_text?: string | null
          resume_word_count?: number | null
          salary_expectation?: number | null
          salary_min?: number | null
          state?: string | null
          target_role?: string | null
          updated_at?: string | null
          veteran_status?: string | null
          willing_to_relocate?: string | null
          work_authorized?: string | null
          years_experience?: string | null
        }
        Relationships: []
      }
      runs: {
        Row: {
          detail: Json | null
          ended_at: string | null
          errors: number | null
          found: number | null
          id: string
          kind: string
          message: string | null
          processed: number | null
          started_at: string | null
          status: string | null
        }
        Insert: {
          detail?: Json | null
          ended_at?: string | null
          errors?: number | null
          found?: number | null
          id?: string
          kind: string
          message?: string | null
          processed?: number | null
          started_at?: string | null
          status?: string | null
        }
        Update: {
          detail?: Json | null
          ended_at?: string | null
          errors?: number | null
          found?: number | null
          id?: string
          kind?: string
          message?: string | null
          processed?: number | null
          started_at?: string | null
          status?: string | null
        }
        Relationships: []
      }
      search_config: {
        Row: {
          auto_apply_score: number | null
          daily_cap: number | null
          exclude_companies: string[] | null
          exclude_titles: string[] | null
          id: number
          include_remote: boolean | null
          include_unknown_location: boolean | null
          locations: string[] | null
          no_go_patterns: string[] | null
          radius_miles: number | null
          remote_ok: boolean | null
          review_score: number | null
          salary_floor: number | null
          same_country_only: boolean
          same_state_only: boolean | null
          sources: string[] | null
          titles: string[] | null
          updated_at: string | null
        }
        Insert: {
          auto_apply_score?: number | null
          daily_cap?: number | null
          exclude_companies?: string[] | null
          exclude_titles?: string[] | null
          id?: number
          include_remote?: boolean | null
          include_unknown_location?: boolean | null
          locations?: string[] | null
          no_go_patterns?: string[] | null
          radius_miles?: number | null
          remote_ok?: boolean | null
          review_score?: number | null
          salary_floor?: number | null
          same_country_only?: boolean
          same_state_only?: boolean | null
          sources?: string[] | null
          titles?: string[] | null
          updated_at?: string | null
        }
        Update: {
          auto_apply_score?: number | null
          daily_cap?: number | null
          exclude_companies?: string[] | null
          exclude_titles?: string[] | null
          id?: number
          include_remote?: boolean | null
          include_unknown_location?: boolean | null
          locations?: string[] | null
          no_go_patterns?: string[] | null
          radius_miles?: number | null
          remote_ok?: boolean | null
          review_score?: number | null
          salary_floor?: number | null
          same_country_only?: boolean
          same_state_only?: boolean | null
          sources?: string[] | null
          titles?: string[] | null
          updated_at?: string | null
        }
        Relationships: []
      }
      site_accounts: {
        Row: {
          created_at: string | null
          email: string
          host: string
          id: string
          job_id: string | null
          last_used_at: string | null
          note: string | null
          password: string
          status: string
        }
        Insert: {
          created_at?: string | null
          email: string
          host: string
          id?: string
          job_id?: string | null
          last_used_at?: string | null
          note?: string | null
          password: string
          status?: string
        }
        Update: {
          created_at?: string | null
          email?: string
          host?: string
          id?: string
          job_id?: string | null
          last_used_at?: string | null
          note?: string | null
          password?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "site_accounts_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "site_accounts_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_apply_queue"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      v_apply_queue: {
        Row: {
          apply_url: string | null
          ats: string | null
          company: string | null
          description: string | null
          id: string | null
          score: number | null
          tailored_resume: string | null
          title: string | null
          url: string | null
        }
        Insert: {
          apply_url?: string | null
          ats?: string | null
          company?: string | null
          description?: string | null
          id?: string | null
          score?: number | null
          tailored_resume?: string | null
          title?: string | null
          url?: string | null
        }
        Update: {
          apply_url?: string | null
          ats?: string | null
          company?: string | null
          description?: string | null
          id?: string | null
          score?: number | null
          tailored_resume?: string | null
          title?: string | null
          url?: string | null
        }
        Relationships: []
      }
      v_candidate_stats: {
        Row: {
          failed: number | null
          pending: number | null
          resolved: number | null
          skipped: number | null
          total: number | null
        }
        Relationships: []
      }
      v_email_stats: {
        Row: {
          action_needed: number | null
          applications_confirmed: number | null
          applications_sent: number | null
          confirmations: number | null
          drafts_waiting: number | null
          interviews: number | null
          offers: number | null
          other: number | null
          received: number | null
          rejections: number | null
          replies_failed: number | null
          replies_sent: number | null
          unread: number | null
        }
        Relationships: []
      }
      v_inbox: {
        Row: {
          category: string | null
          classify_why: string | null
          confidence: string | null
          from_addr: string | null
          id: string | null
          is_read: boolean | null
          job_company: string | null
          job_id: string | null
          job_status: string | null
          job_title: string | null
          message_id: string | null
          received_at: string | null
          replied_at: string | null
          reply_draft: string | null
          reply_error: string | null
          reply_state: string | null
          snippet: string | null
          subject: string | null
          thread_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "emails_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "emails_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "v_apply_queue"
            referencedColumns: ["id"]
          },
        ]
      }
      v_stats: {
        Row: {
          applied: number | null
          applied_today: number | null
          confirmed: number | null
          interviews: number | null
          needs_help: number | null
          new: number | null
          offers: number | null
          queued: number | null
          rejected: number | null
          remote_jobs: number | null
          review: number | null
          total: number | null
          within_25mi: number | null
          within_40mi: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      applications_today: { Args: never; Returns: number }
      claim_next_job: {
        Args: never
        Returns: {
          apply_url: string
          ats: string
          company: string
          description: string
          id: string
          score: number
          tailored_resume: string
          title: string
          url: string
        }[]
      }
      find_answer: {
        Args: { q: string }
        Returns: {
          answer: string
          confirmed: boolean
          similarity: number
        }[]
      }
      is_app_owner: { Args: never; Returns: boolean }
    }
    Enums: {
      [_ in never]: never
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
