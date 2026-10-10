// Package db opens the pgx pool (bench, tools, RAG) and the GORM-backed ADK
// session service. App SQL is always schema-qualified ("app."); search_path
// is left at its default so ADK's GORM tables are created in "public".
package db

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	pgxvec "github.com/pgvector/pgvector-go/pgx"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/session/database"
)

// AfterConnectHook runs on each new pool connection (e.g. statement prepare).
type AfterConnectHook func(ctx context.Context, conn *pgx.Conn) error

// OpenPool creates the pgxpool with pgvector types registered, then waits
// (up to wait) for the database to answer.
func OpenPool(ctx context.Context, url string, maxConns int, wait time.Duration, hooks ...AfterConnectHook) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	cfg.MaxConns = int32(maxConns)
	cfg.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
		if err := pgxvec.RegisterTypes(ctx, conn); err != nil {
			return fmt.Errorf("register pgvector: %w", err)
		}
		for _, h := range hooks {
			if err := h(ctx, conn); err != nil {
				return err
			}
		}
		return nil
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(wait)
	for {
		pctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		err = pool.Ping(pctx)
		cancel()
		if err == nil {
			return pool, nil
		}
		if time.Now().After(deadline) || ctx.Err() != nil {
			pool.Close()
			return nil, fmt.Errorf("database not reachable: %w", err)
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// OpenSessionService opens ADK's GORM session service on Postgres and runs
// its AutoMigrate (tables in the public schema).
func OpenSessionService(url string, maxConns int) (session.Service, error) {
	gdb, err := gorm.Open(postgres.Open(url), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		return nil, fmt.Errorf("open gorm: %w", err)
	}
	sqlDB, err := gdb.DB()
	if err != nil {
		return nil, err
	}
	sqlDB.SetMaxOpenConns(maxConns)
	sqlDB.SetMaxIdleConns(maxConns)
	sqlDB.SetConnMaxIdleTime(5 * time.Minute)
	svc, err := database.NewSessionServiceFromDB(gdb)
	if err != nil {
		return nil, err
	}
	if err := database.AutoMigrate(svc); err != nil {
		return nil, err
	}
	return svc, nil
}
