package session

import (
	"encoding/json"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/streamnorm"
)

// AppendFrame persists one normalized frame. It implements
// streamnorm.FrameStore so the agent loop stores frames through the same
// Store it already uses for legacy events.
func (s *Store) AppendFrame(runID string, seq int, frame streamnorm.Event) error {
	b, _ := json.Marshal(frame)
	_, err := s.db.Exec(`INSERT INTO ai_frames(run_id,seq,type,frame_json,created_at) VALUES(?,?,?,?,?)`,
		runID, seq, frame.Type, string(b), nowMS())
	return err
}

// ListFrames replays normalized frames after seq, in order.
func (s *Store) ListFrames(runID string, afterSeq int) ([]streamnorm.StoredFrame, error) {
	rows, err := s.db.Query(`SELECT seq,type,frame_json FROM ai_frames WHERE run_id=? AND seq>? ORDER BY seq ASC`, runID, afterSeq)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []streamnorm.StoredFrame
	for rows.Next() {
		var seq int
		var typ, frame string
		if err := rows.Scan(&seq, &typ, &frame); err != nil {
			return nil, err
		}
		out = append(out, streamnorm.StoredFrame{Seq: seq, Type: typ, Frame: json.RawMessage(frame)})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
